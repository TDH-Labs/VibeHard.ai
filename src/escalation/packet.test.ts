import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEscalationPacket, findingRef } from "./packet.ts";
import type { Finding, GateVerdict } from "../types.ts";

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function workspace(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "drydock-pkt-"));
  tmps.push(d);
  for (const [path, content] of Object.entries(files)) await Bun.write(join(d, path), content);
  return d;
}
const verdict = (gate: string, findings: Finding[]): GateVerdict => ({
  gate,
  status: findings.length ? "block" : "pass",
  findings,
  blocking: findings.length,
  ranAt: "2026-06-21T00:00:00.000Z",
});

describe("findingRef", () => {
  test("stable id from file:line:ruleId", () => {
    expect(findingRef({ tool: "t", ruleId: "r", severity: "high", file: "a.ts", line: 7, message: "m" })).toBe("a.ts:7:r");
    expect(findingRef({ tool: "t", ruleId: "r", severity: "high", file: "a.ts", message: "m" })).toBe("a.ts:?:r");
  });
});

describe("buildEscalationPacket", () => {
  test("localizes a slice and resolves the /src container path; routes by tool", async () => {
    const dir = await workspace({ "server.js": "a\nb\nc\nLEAK\ne\nf\ng" });
    // semgrep reports a /src/<rel> path (container mount) — must resolve to server.js.
    const finding: Finding = {
      tool: "semgrep",
      ruleId: "sqli",
      severity: "high",
      file: "/src/server.js",
      line: 4,
      message: "SQL injection",
    };
    const packet = await buildEscalationPacket([verdict("sast", [finding])], dir, { now: "2026-06-21T00:00:00.000Z" });

    expect(packet.blocking).toBe(1);
    expect(packet.specialties).toEqual(["security"]);
    const item = packet.items[0]!;
    expect(item.specialty).toBe("security");
    expect(item.ref).toBe("/src/server.js:4:sqli");
    expect(item.slice).not.toBeNull();
    expect(item.slice!.file).toBe("server.js"); // workspace-relative, /src stripped
    expect(item.slice!.startLine).toBe(1); // line 4 − 3 context
    expect(item.slice!.endLine).toBe(7);
    expect(item.slice!.code).toContain("LEAK");
  });

  test("only blocking findings are escalated (block-by-default keeps the queue small)", async () => {
    const dir = await workspace({ "a.ts": "x" });
    const high: Finding = { tool: "semgrep", ruleId: "r1", severity: "high", file: "/src/a.ts", line: 1, message: "" };
    const low: Finding = { tool: "semgrep", ruleId: "r2", severity: "low", file: "/src/a.ts", line: 1, message: "" };
    const packet = await buildEscalationPacket([verdict("sast", [high, low])], dir, {});
    expect(packet.items).toHaveLength(1);
    expect(packet.items[0]!.finding.ruleId).toBe("r1");
  });

  test("a finding with no line (or unreadable file) yields an item with a null slice", async () => {
    const dir = await workspace({ "a.ts": "x" });
    const noLine: Finding = { tool: "verify", ruleId: "health-check-failed", severity: "high", file: "server.js", message: "dead" };
    const packet = await buildEscalationPacket([verdict("verify", [noLine])], dir, {});
    expect(packet.items[0]!.slice).toBeNull();
    expect(packet.items[0]!.specialty).toBe("reliability");
  });
});
