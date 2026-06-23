import { describe, expect, test } from "bun:test";
import { GitHubEscalationSink } from "./github.ts";
import type { EscalationPacket } from "./packet.ts";

/** A stateful in-memory GitHub Issues API: POST creates, GET lists, PATCH updates. */
function fakeGitHub() {
  const issues: Array<{ number: number; body: string; labels: string[]; state: string; title: string }> = [];
  const calls: Array<{ method: string; path: string; auth?: string }> = [];
  let n = 0;
  const jsonRes = (status: number, obj: unknown) =>
    ({ ok: status < 400, status, text: async () => JSON.stringify(obj) }) as unknown as Response;
  const impl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com", "");
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ method, path, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (method === "POST" && /\/issues$/.test(path)) {
      const issue = { number: ++n, body: String(body!.body), labels: (body!.labels as string[]) ?? [], state: "open", title: String(body!.title) };
      issues.push(issue);
      return jsonRes(201, { number: issue.number, html_url: `https://github.com/r/issues/${issue.number}` });
    }
    if (method === "GET" && /\/issues\?/.test(path)) {
      return jsonRes(200, issues.map((i) => ({ number: i.number, body: i.body })));
    }
    const pm = path.match(/\/issues\/(\d+)$/);
    if (method === "PATCH" && pm) {
      const issue = issues.find((i) => i.number === Number(pm[1]));
      if (issue && body) {
        if (body.body !== undefined) issue.body = String(body.body);
        if (body.labels) issue.labels = body.labels as string[];
        if (body.state) issue.state = String(body.state);
      }
      return jsonRes(200, { number: issue?.number });
    }
    return jsonRes(404, { message: `unhandled ${method} ${path}` });
  }) as unknown as typeof fetch;
  return { impl, issues, calls };
}

// A packet whose code slice contains "-->" — must NOT break the HTML-comment embed (base64).
const packet = {
  workspacePath: "/ws",
  createdAt: "2026-06-22T00:00:00.000Z",
  reason: "deploy blocked by the gate chain",
  items: [
    {
      ref: "app.ts:5:sast-sqli",
      finding: { tool: "semgrep", ruleId: "sast-sqli", severity: "critical", file: "app.ts", line: 5, message: "possible SQL injection" },
      specialty: "security",
      slice: { file: "app.ts", startLine: 2, endLine: 8, code: "const q = `SELECT ...`; // edge --> case" },
    },
  ],
  specialties: ["security"],
  blocking: 1,
} as unknown as EscalationPacket;

const sink = (fake: ReturnType<typeof fakeGitHub>) =>
  new GitHubEscalationSink({ repo: "owner/repo", token: "ghp_test", fetchImpl: fake.impl });

describe("GitHubEscalationSink", () => {
  test("constructor requires repo + token", () => {
    expect(() => new GitHubEscalationSink({ repo: "", token: "t" })).toThrow(/repo/);
    expect(() => new GitHubEscalationSink({ repo: "o/r", token: "" })).toThrow(/GITHUB_PAT/);
  });

  test("open creates ONE issue, returns a needs-human ticket, and is idempotent", async () => {
    const fake = fakeGitHub();
    const s = sink(fake);
    const t1 = await s.open(packet, "2026-06-22T00:00:00.000Z");
    expect(t1.state).toBe("needs-human");
    expect(fake.issues.length).toBe(1);
    expect(fake.issues[0]!.labels).toContain("needs-human");
    const t2 = await s.open(packet, "2026-06-22T01:00:00.000Z"); // same packet → same id
    expect(t2.id).toBe(t1.id);
    expect(fake.issues.length).toBe(1); // NO second issue
  });

  test("get round-trips the full ticket — even a slice containing '-->' (base64 embed)", async () => {
    const fake = fakeGitHub();
    const s = sink(fake);
    const opened = await s.open(packet, "2026-06-22T00:00:00.000Z");
    const got = await s.get(opened.id);
    expect(got).not.toBeNull();
    expect(got!.packet.items[0]!.slice!.code).toContain("--> case"); // survived the HTML comment
    expect(got!.packet.blocking).toBe(1);
  });

  test("claim → claimed + label; resolve → resolved + issue closed", async () => {
    const fake = fakeGitHub();
    const s = sink(fake);
    const { id } = await s.open(packet, "2026-06-22T00:00:00.000Z");
    const claimed = await s.claim(id, "alice", "2026-06-22T02:00:00.000Z");
    expect(claimed.state).toBe("claimed");
    expect(claimed.claimedBy).toBe("alice");
    expect(fake.issues[0]!.labels).toContain("claimed");
    const resolved = await s.resolve(id, [{ ref: "app.ts:5:sast-sqli", verdict: "confirmed-fix" } as never], "2026-06-22T03:00:00.000Z");
    expect(resolved.state).toBe("resolved");
    expect(fake.issues[0]!.state).toBe("closed"); // the issue is closed on resolve
  });

  test("list filters by state; the token rides in the Authorization header (never the path)", async () => {
    const fake = fakeGitHub();
    const s = sink(fake);
    const { id } = await s.open(packet, "2026-06-22T00:00:00.000Z");
    expect((await s.list("needs-human")).length).toBe(1);
    expect((await s.list("resolved")).length).toBe(0);
    await s.claim(id, "bob", "2026-06-22T02:00:00.000Z");
    expect((await s.list("claimed")).length).toBe(1);
    expect(fake.calls.every((c) => c.auth === "Bearer ghp_test")).toBe(true);
    expect(fake.calls.every((c) => !c.path.includes("ghp_test"))).toBe(true);
  });
});
