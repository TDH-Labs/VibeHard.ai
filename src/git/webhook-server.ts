/**
 * Webhook HTTP server for "git repo = shared state" (roadmap Phase 4, live half). Receives GitHub
 * push events, verifies the HMAC signature, maps repo+branch to a local app path via the registry,
 * then re-gates the app (pull latest → full gate chain). Returns 200 immediately so GitHub's delivery
 * timeout never fires; the gate runs async.
 *
 * Start with: `vibehard git-serve [port]` (default 3000).
 * GitHub App → Webhook URL: `https://your-host/webhook/github`
 */
import { readFileSync } from "node:fs";
import { verifyWebhookSignature, interpretPushWebhook } from "./webhook.ts";
import { findAppByRepo } from "./provision.ts";
import { gitRepo } from "./repo.ts";
import { pullLatest } from "./coordinate.ts";

export interface WebhookServerOptions {
  port?: number;
  secret: string;
  /** Called after a successful pull+re-gate; inject for tests. Default: runs the real gate chain. */
  onWake?: (appPath: string, repo: string, branch: string, after: string) => Promise<void>;
}

async function defaultOnWake(appPath: string, repo: string, branch: string, after: string): Promise<void> {
  const { runGate } = await import("../gate/index.ts");
  console.log(`[webhook] wake: ${repo}@${branch} (${after.slice(0, 8)}) → ${appPath}`);

  // pull the SWE's changes before re-gating
  const gr = gitRepo(appPath);
  const pull = pullLatest(gr);
  if (pull.conflict) {
    console.error(`[webhook] merge conflict in ${appPath} — needs human resolution`);
    return;
  }
  if (!pull.pulled) {
    console.warn(`[webhook] could not pull for ${appPath}: ${pull.reason}`);
  }

  const result = await runGate(appPath);
  const blocked = result.verdicts.filter((v) => v.status === "block");
  const status = blocked.length > 0 ? "BLOCK" : "PASS";
  console.log(`[webhook] gate ${status} for ${repo}: ${blocked.length} blocking verdict(s)`);
  if (blocked.length > 0) {
    for (const v of blocked) {
      for (const f of v.findings.filter((x) => x.severity === "critical" || x.severity === "high")) {
        console.log(`  • [${v.gate}] ${f.message}`);
      }
    }
  }
}

export interface WebhookServer {
  port: number;
  stop(): void;
}

export function startWebhookServer(opts: WebhookServerOptions): WebhookServer {
  const secret = opts.secret;
  const onWake = opts.onWake ?? defaultOnWake;
  const port = opts.port ?? 3000;

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // health check
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ ok: true, service: "vibehard-webhook" }), { headers: { "content-type": "application/json" } });
      }

      if (url.pathname !== "/webhook/github" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }

      const rawBody = await req.text();
      const sig = req.headers.get("x-hub-signature-256") ?? undefined;

      if (!verifyWebhookSignature(secret, rawBody, sig)) {
        console.warn("[webhook] rejected: invalid signature");
        return new Response("forbidden", { status: 403 });
      }

      const headers: Record<string, string | undefined> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      const intent = interpretPushWebhook(headers, rawBody, { ignoreActors: ["vibehard-gate[bot]"] });

      if (intent.kind === "ignore") {
        console.log(`[webhook] ignored: ${intent.reason ?? "no reason"}`);
        return new Response("ok", { status: 200 });
      }

      const { repo, branch, after } = intent;
      if (!repo || !branch || !after) {
        return new Response("ok", { status: 200 });
      }

      const appPath = findAppByRepo(repo, branch);
      if (!appPath) {
        console.warn(`[webhook] no registered app for ${repo}@${branch} — run 'vibehard git-connect <dir>'`);
        return new Response("ok", { status: 200 });
      }

      // respond immediately — GitHub times out deliveries at 10s
      setImmediate(() => { onWake(appPath, repo, branch, after).catch((e: unknown) => console.error("[webhook] gate error:", e)); });
      return new Response("ok", { status: 200 });
    },
  });

  console.log(`[webhook] listening on :${port}  POST /webhook/github`);
  return { port, stop: () => server.stop() };
}

/** Resolve the webhook secret from env. Throws if not configured. */
export function webhookSecretFromEnv(): string {
  const s = process.env.GITHUB_WEBHOOK_SECRET;
  if (!s) throw new Error("GITHUB_WEBHOOK_SECRET is not set — generate one with: openssl rand -hex 32");
  return s;
}

/** Build a `GitProvider` from env: GitHub App if GITHUB_APP_ID+key are set, else PAT. */
export async function gitProviderFromEnv() {
  const { gitHubProvider } = await import("./provider.ts");
  const { appCredentialsFromEnv, installationTokenProvider } = await import("./app-auth.ts");

  const creds = appCredentialsFromEnv((p: string) => readFileSync(p, "utf8"));
  if (creds) {
    // GitHub App: we need an installation ID. Read it from env or the registry's first entry.
    const installId = process.env.GITHUB_APP_INSTALLATION_ID ? parseInt(process.env.GITHUB_APP_INSTALLATION_ID, 10) : undefined;
    if (!installId) throw new Error("GITHUB_APP_INSTALLATION_ID not set — find it at https://github.com/settings/installations after installing the app");
    const getToken = installationTokenProvider(creds, installId);
    return { provider: gitHubProvider(getToken), getToken };
  }

  const pat = process.env.GITHUB_PAT;
  if (pat) {
    const getToken = async () => pat;
    return { provider: gitHubProvider(getToken), getToken };
  }

  throw new Error("no GitHub credentials — set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_PATH, or GITHUB_PAT");
}
