/**
 * Git provisioning for "git repo = shared state" (roadmap Phase 4, live half). One call wires a
 * generated app to a GitHub repo: creates the repo if needed, pushes the current build, writes the
 * CI gate workflow, registers the VibeHard webhook on the repo, and records the mapping in the local
 * registry so the webhook server can wake the right gate loop on a future push.
 *
 * Designed to be idempotent — re-running on an already-connected app is a no-op (repo exists, push
 * fast-forwards, workflow already marker-owned, webhook already registered).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GitProvider } from "./provider.ts";
import { gitRepo, bunGitRunner } from "./repo.ts";
import { generateCiWorkflow } from "./ci.ts";
import { commitAndPush } from "./coordinate.ts";

// ── Registry ────────────────────────────────────────────────────────────────

const registryPath = (): string => join(process.env.HOME ?? "~", ".vibehard", "git-registry.json");

export interface RegistryEntry {
  appPath: string;
  repo: string;   // "owner/name"
  branch: string;
  installationId?: number;
}

export function loadRegistry(): RegistryEntry[] {
  const p = registryPath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")) as RegistryEntry[]; } catch { return []; }
}

function saveRegistry(entries: RegistryEntry[]): void {
  const p = registryPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(entries, null, 2));
}

export function registerApp(entry: RegistryEntry): void {
  const entries = loadRegistry().filter((e) => e.appPath !== entry.appPath);
  saveRegistry([...entries, entry]);
}

export function findAppByRepo(repo: string, branch: string): string | undefined {
  return loadRegistry().find((e) => e.repo === repo && e.branch === branch)?.appPath;
}

// ── Per-app git config (.vibehard/git.json) ─────────────────────────────────

export interface GitConfig {
  repo: string;
  branch: string;
  installationId?: number;
  prUrl?: string;
}

export function readGitConfig(appPath: string): GitConfig | null {
  const p = join(appPath, ".vibehard", "git.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as GitConfig; } catch { return null; }
}

function writeGitConfig(appPath: string, cfg: GitConfig): void {
  const dir = join(appPath, ".vibehard");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "git.json"), JSON.stringify(cfg, null, 2));
}

// ── Webhook registration ─────────────────────────────────────────────────────

async function registerWebhook(repo: string, getToken: () => Promise<string>, webhookUrl: string, secret: string): Promise<void> {
  const token = await getToken();
  const res = await fetch(`https://api.github.com/repos/${repo}/hooks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    body: JSON.stringify({ name: "web", active: true, events: ["push"], config: { url: webhookUrl, content_type: "json", secret, insecure_ssl: "0" } }),
  });
  if (!res.ok) {
    const text = await res.text();
    // 422 = hook already exists — idempotent
    if (res.status !== 422) throw new Error(`register webhook on ${repo}: ${res.status} ${text.slice(0, 200)}`);
  }
}

// ── Main provision ───────────────────────────────────────────────────────────

export interface ProvisionOptions {
  /** "owner/name" — if omitted, the app dir name is used as the repo name under the authed owner. */
  repoName?: string;
  /** Branch VibeHard pushes to. Default "vibehard/build". */
  branch?: string;
  /** Webhook URL to register. If omitted, webhook registration is skipped (activate manually). */
  webhookUrl?: string;
  /** Webhook secret. Required when webhookUrl is provided. */
  webhookSecret?: string;
  /** Open a PR from the build branch into base when the build branch differs from base. */
  openPr?: boolean;
  baseBranch?: string;
  /** Injected for tests. Defaults to global fetch. */
  getToken?: () => Promise<string>;
}

export interface ProvisionResult {
  repo: string;
  branch: string;
  repoUrl: string;
  created: boolean;
  pushed: boolean;
  ciWritten: boolean;
  webhookRegistered: boolean;
  prUrl?: string;
}

export async function provisionGitRepo(
  appPath: string,
  provider: GitProvider,
  opts: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const absPath = resolve(appPath);
  const branch = opts.branch ?? "vibehard/build";
  const baseBranch = opts.baseBranch ?? "main";

  // 1. ensure the repo exists
  const inferredName = absPath.split("/").at(-1) ?? "vibehard-app";
  const repoArg = opts.repoName ?? inferredName;
  const { repo, created } = await provider.ensureRepo(repoArg, { private: true });

  // 2. write the CI workflow (idempotent — marker-gated)
  const ci = generateCiWorkflow(absPath, { baseBranch });

  // 3. init local git + push
  const gr = gitRepo(absPath);
  let pushed = false;
  if (!gr.hasRemote()) {
    const remoteUrl = await provider.authedRemoteUrl(repo);
    const r = bunGitRunner(["remote", "add", "origin", remoteUrl], absPath);
    if (r.exitCode !== 0 && !r.stderr.includes("already exists")) throw new Error(`git remote add: ${r.stderr}`);
  }
  const sync = commitAndPush(gr, "vibehard: connect to GitHub");
  pushed = sync.pushed;

  // 4. optionally open a PR
  let prUrl: string | undefined;
  if (opts.openPr && pushed) {
    try {
      const pr = await provider.openPullRequest({ repo, head: branch, base: baseBranch, title: "VibeHard gate build", body: "Automated build from VibeHard. Gates run as required checks on this PR." });
      prUrl = pr.url;
    } catch {
      // PR may already exist — not fatal
    }
  }

  // 5. register webhook
  let webhookRegistered = false;
  if (opts.webhookUrl && opts.webhookSecret && opts.getToken) {
    await registerWebhook(repo, opts.getToken, opts.webhookUrl, opts.webhookSecret);
    webhookRegistered = true;
  }

  // 6. persist config + registry
  const cfg: GitConfig = { repo, branch, prUrl };
  writeGitConfig(absPath, cfg);
  registerApp({ appPath: absPath, repo, branch });

  return {
    repo,
    branch,
    repoUrl: `https://github.com/${repo}`,
    created,
    pushed,
    ciWritten: ci.written,
    webhookRegistered,
    prUrl,
  };
}
