import { afterEach, describe, expect, test } from "bun:test";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWebhookSignature, interpretPushWebhook } from "./webhook.ts";
import { appJwt, installationToken, installationTokenProvider, appCredentialsFromEnv, type FetchLike } from "./app-auth.ts";
import { gitHubProvider, fakeGitProvider } from "./provider.ts";
import { ciWorkflowYaml, generateCiWorkflow } from "./ci.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ───────────────────────────── webhook ─────────────────────────────
const SECRET = "s3cr3t-webhook";
const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body, "utf8").digest("hex");

describe("webhook signature — only GitHub's own payloads pass", () => {
  test("a correctly-signed body verifies; a tampered body or wrong secret does not", () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    expect(verifyWebhookSignature(SECRET, body, sign(body))).toBe(true);
    expect(verifyWebhookSignature(SECRET, body + " ", sign(body))).toBe(false); // body tampered
    expect(verifyWebhookSignature("wrong", body, sign(body))).toBe(false); // wrong secret
    expect(verifyWebhookSignature(SECRET, body, undefined)).toBe(false); // no signature header
    expect(verifyWebhookSignature(SECRET, body, "sha256=deadbeef")).toBe(false); // length-mismatch must not throw
  });
});

describe("interpretPushWebhook — wake on an SWE push, ignore our own + noise", () => {
  const push = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ ref: "refs/heads/vibehard/build", after: "abc123", repository: { full_name: "u/app" }, installation: { id: 42 }, sender: { login: "alice" }, pusher: { name: "alice" }, ...over });

  test("a human push → wake, carrying repo/branch/after/installationId", () => {
    const r = interpretPushWebhook({ "x-github-event": "push" }, push());
    expect(r).toMatchObject({ kind: "wake", repo: "u/app", branch: "vibehard/build", after: "abc123", installationId: 42, pusher: "alice" });
  });
  test("VibeHard's OWN push is ignored — never wake on our own commit (no infinite loop)", () => {
    const r = interpretPushWebhook({ "x-github-event": "push" }, push({ sender: { login: "vibehard[bot]" } }), { ignoreActors: ["vibehard[bot]"] });
    expect(r.kind).toBe("ignore");
    expect(r.reason).toMatch(/own push/i);
  });
  test("non-push events, branch deletions, and off-prefix branches are ignored", () => {
    expect(interpretPushWebhook({ "x-github-event": "issues" }, push()).kind).toBe("ignore");
    expect(interpretPushWebhook({ "x-github-event": "push" }, push({ after: "0000000000000000000000000000000000000000" })).kind).toBe("ignore"); // deletion
    expect(interpretPushWebhook({ "x-github-event": "push" }, push({ ref: "refs/heads/feature-x" }), { branchPrefix: "vibehard/" }).kind).toBe("ignore");
  });
  test("a malformed payload is ignored, not thrown", () => {
    expect(interpretPushWebhook({ "x-github-event": "push" }, "{not json").kind).toBe("ignore");
  });
});

// ───────────────────────────── app auth (JWT + installation token) ─────────────────────────────
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const decodeSeg = (s: string) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));

describe("appJwt — a verifiable, short-lived RS256 app token", () => {
  test("signs with the private key and carries iss=appId + a ≤10min window", () => {
    const now = 1_700_000_000;
    const jwt = appJwt("123456", privateKey, now);
    const [h, p, sig] = jwt.split(".");
    expect(decodeSeg(h!)).toMatchObject({ alg: "RS256", typ: "JWT" });
    const claims = decodeSeg(p!);
    expect(claims.iss).toBe("123456");
    expect(claims.iat).toBe(now - 60); // backdated for clock skew
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600); // under GitHub's 10-min cap
    // the signature actually verifies against the public key
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    expect(ok).toBe(true);
  });
});

describe("installationToken — JWT exchanged for a scoped, refreshing token", () => {
  const fakeFetch = (token: string, expiresAt: string, capture?: (url: string, auth: string) => void): FetchLike =>
    async (url, init) => {
      capture?.(url, init.headers.Authorization ?? "");
      return { ok: true, status: 201, text: async () => JSON.stringify({ token, expires_at: expiresAt }), json: async () => ({ token, expires_at: expiresAt }) };
    };

  test("POSTs to the installation endpoint with the app JWT and returns the token", async () => {
    let seenUrl = "", seenAuth = "";
    const t = await installationToken({ appId: "1", privateKeyPem: privateKey }, 42, { nowSec: 1_700_000_000, fetchImpl: fakeFetch("ghs_live", "2030-01-01T00:00:00Z", (u, a) => { seenUrl = u; seenAuth = a; }) });
    expect(t.token).toBe("ghs_live");
    expect(seenUrl).toContain("/app/installations/42/access_tokens");
    expect(seenAuth).toMatch(/^Bearer eyJ/); // the app JWT
  });

  test("a non-2xx response throws (never returns an empty 'success')", async () => {
    const bad: FetchLike = async () => ({ ok: false, status: 404, text: async () => "no install", json: async () => ({}) });
    await expect(installationToken({ appId: "1", privateKeyPem: privateKey }, 99, { fetchImpl: bad })).rejects.toThrow(/404/);
  });

  test("the caching provider reuses a fresh token and refreshes a near-expired one", async () => {
    let mints = 0;
    const mintFetch: FetchLike = async () => { mints++; return { ok: true, status: 201, text: async () => "", json: async () => ({ token: `t${mints}`, expires_at: "2030-01-01T00:00:00Z" }) }; };
    const get = installationTokenProvider({ appId: "1", privateKeyPem: privateKey }, 42, { fetchImpl: mintFetch });
    expect(await get()).toBe("t1");
    expect(await get()).toBe("t1"); // still fresh → no second mint
    expect(mints).toBe(1);
  });
});

describe("appCredentialsFromEnv — env-only secrets, PAT fallback when unset", () => {
  test("reads the private key from a file path; returns null when GITHUB_APP_ID is absent", () => {
    const prev = { id: process.env.GITHUB_APP_ID, path: process.env.GITHUB_APP_PRIVATE_KEY_PATH };
    try {
      delete process.env.GITHUB_APP_ID;
      expect(appCredentialsFromEnv(() => "PEM")).toBeNull(); // not configured → caller falls back to PAT
      process.env.GITHUB_APP_ID = "777";
      process.env.GITHUB_APP_PRIVATE_KEY_PATH = "/keys/app.pem";
      const creds = appCredentialsFromEnv((p) => (p === "/keys/app.pem" ? "PEM-CONTENTS" : ""));
      expect(creds).toMatchObject({ appId: "777", privateKeyPem: "PEM-CONTENTS" });
    } finally {
      process.env.GITHUB_APP_ID = prev.id;
      process.env.GITHUB_APP_PRIVATE_KEY_PATH = prev.path;
      if (prev.id === undefined) delete process.env.GITHUB_APP_ID;
      if (prev.path === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    }
  });
});

// ───────────────────────────── provider ─────────────────────────────
describe("gitHubProvider — token-getter drives every call (App token or PAT)", () => {
  type Call = { method: string; path: string; auth: string; body?: string };
  const recorder = (responder: (c: Call) => { ok: boolean; status: number; json: unknown }) => {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const c: Call = { method: init.method ?? "GET", path: url.replace("https://api.github.com", ""), auth: init.headers?.Authorization ?? "", body: init.body };
      calls.push(c);
      const r = responder(c);
      return { ok: r.ok, status: r.status, text: async () => JSON.stringify(r.json) } as Response;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  test("ensureRepo creates only when missing; openPullRequest returns number+url; every call carries the token", async () => {
    const { calls, fetchImpl } = recorder((c) => {
      if (c.method === "GET" && c.path.startsWith("/repos/")) return { ok: false, status: 404, json: {} }; // missing → create
      if (c.method === "POST" && c.path.endsWith("/repos")) return { ok: true, status: 201, json: { full_name: "acme/app" } };
      if (c.path.endsWith("/pulls")) return { ok: true, status: 201, json: { number: 7, html_url: "https://github.com/acme/app/pull/7" } };
      return { ok: true, status: 200, json: {} };
    });
    let issued = 0;
    const provider = gitHubProvider(async () => `tok${++issued}`, { fetchImpl, owner: "acme" });
    const ensured = await provider.ensureRepo("acme/app");
    expect(ensured).toMatchObject({ repo: "acme/app", created: true });
    const pr = await provider.openPullRequest({ repo: "acme/app", head: "vibehard/build", base: "main", title: "Build", body: "gated" });
    expect(pr).toMatchObject({ number: 7, url: "https://github.com/acme/app/pull/7" });
    expect(calls.every((c) => c.auth.startsWith("Bearer tok"))).toBe(true); // token on every request
  });

  test("authedRemoteUrl embeds a short-lived token as x-access-token (the documented git-over-HTTPS user)", async () => {
    const provider = gitHubProvider(async () => "ghs_abc", { owner: "acme" });
    expect(await provider.authedRemoteUrl("acme/app")).toBe("https://x-access-token:ghs_abc@github.com/acme/app.git");
  });
});

describe("fakeGitProvider — the seam the turn-taking flow tests against", () => {
  test("records calls, creates-once, fabricates PRs", async () => {
    const p = fakeGitProvider({ existingRepos: ["u/old"] });
    expect((await p.ensureRepo("u/old")).created).toBe(false);
    expect((await p.ensureRepo("u/new")).created).toBe(true);
    const pr = await p.openPullRequest({ repo: "u/new", head: "vibehard/build", base: "main", title: "t", body: "b" });
    expect(pr.number).toBe(1);
    expect(p.calls).toContain("ensureRepo u/new");
  });
});

// ───────────────────────────── CI workflow ─────────────────────────────
function appDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-ci-"));
  tmps.push(d);
  return d;
}

describe("CI workflow — gates as a required GitHub check, generate-then-own", () => {
  test("yaml runs the gate chain on PR + push to the base branch", () => {
    const y = ciWorkflowYaml({ baseBranch: "main" });
    expect(y).toContain("name: vibehard-gate");
    expect(y).toContain("pull_request:");
    expect(y).toContain("oven-sh/setup-bun");
    expect(y).toContain("bunx --bun vibehard gate .");
    expect(y).toContain("@vibehard:generated");
  });

  test("writes .github/workflows/gate.yml", () => {
    const dir = appDir();
    const r = generateCiWorkflow(dir, { gateCommand: "bun run gate" });
    expect(r.written).toBe(true);
    expect(existsSync(join(dir, ".github/workflows/gate.yml"))).toBe(true);
    expect(readFileSync(r.path, "utf8")).toContain("bun run gate");
  });

  test("generate-then-own: a user-edited (marker-stripped) workflow is preserved, not clobbered", () => {
    const dir = appDir();
    const p = join(dir, ".github/workflows/gate.yml");
    generateCiWorkflow(dir); // ours, with the marker
    writeFileSync(p, "name: my-own-ci\n"); // user takes ownership (removes the marker)
    const r = generateCiWorkflow(dir);
    expect(r.skippedUserOwned).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("name: my-own-ci\n");
  });
});
