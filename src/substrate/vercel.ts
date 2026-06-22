/**
 * VercelHostProvider — the HostProvider deploy leg (v1, CLI-based). Shells out to the
 * Vercel CLI to deploy the gated workspace and returns the live URL. The command runner
 * is an injectable seam (default: Bun.spawn), so arg assembly + URL parsing unit-test
 * with a fake — no network. The token is passed via the VERCEL_TOKEN env, NEVER argv
 * (so it can't leak into a process list).
 *
 * Per the orchestrator, deploy() receives only { SUPABASE_URL, SUPABASE_ANON_KEY } as
 * env — the service-role key never reaches the host (§16 / R6.2).
 */
import { basename } from "node:path";
import type { HostProvider } from "./types.ts";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface CommandRunner {
  run(cmd: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<CommandResult>;
}

/** Default runner over Bun.spawn (the only place real I/O happens). */
export const bunRunner: CommandRunner = {
  run: async (cmd, opts) => {
    const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  },
};

export interface VercelHostOptions {
  token?: string; // defaults to VERCEL_TOKEN
  scope?: string; // team slug/id — REQUIRED in non-interactive mode for team tokens (VERCEL_SCOPE)
  runner?: CommandRunner;
  vercelBin?: string[]; // default ["bunx","vercel"] (Bun's runner — own cache, no npm)
  prod?: boolean; // default true (a real production URL)
}

/** Vercel project names: lowercase, alnum + . _ -, no `---` run, ≤100 chars. */
export function sanitizeProjectName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-") // collapse runs → never `---` (a Vercel constraint)
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 100) || "app"
  );
}

/** Pull the first `https://….vercel.app` URL out of the CLI output. */
export function firstVercelUrl(...texts: string[]): string | null {
  for (const t of texts) {
    const m = t.match(/https:\/\/[a-z0-9.-]+\.vercel\.app/i);
    if (m) return m[0];
  }
  return null;
}

export class VercelHostProvider implements HostProvider {
  readonly name = "vercel";
  private readonly token: string;
  private readonly scope: string;
  private readonly runner: CommandRunner;
  private readonly vercelBin: string[];
  private readonly prod: boolean;

  constructor(opts: VercelHostOptions = {}) {
    this.token = opts.token ?? process.env.VERCEL_TOKEN ?? "";
    this.scope = opts.scope ?? process.env.VERCEL_SCOPE ?? process.env.VERCEL_TEAM_ID ?? "";
    this.runner = opts.runner ?? bunRunner;
    this.vercelBin = opts.vercelBin ?? ["bunx", "vercel"];
    this.prod = opts.prod ?? true;
  }

  async deploy(workspacePath: string, env: Record<string, string>, hostRef: string | null): Promise<{ url: string; hostRef: string }> {
    if (!this.token) throw new Error("VercelHostProvider: missing VERCEL_TOKEN");
    // Pin the project name explicitly (sanitized) — Vercel otherwise derives it from the
    // path, which fails on uppercase/odd dir names. Stable name → idempotent redeploys.
    const project = hostRef ?? sanitizeProjectName(basename(workspacePath));
    const args = [...this.vercelBin, "deploy", "--yes", "--name", project];
    if (this.scope) args.push("--scope", this.scope);
    if (this.prod) args.push("--prod");
    for (const [k, v] of Object.entries(env)) {
      // Pass BOTH runtime (-e) and build-time (--build-env): Next.js inlines NEXT_PUBLIC_*
      // during `next build`, so a runtime-only var is undefined at prerender. (All values
      // here are url/anon — public — so build-time exposure is fine; never the service key.)
      args.push("-e", `${k}=${v}`);
      args.push("--build-env", `${k}=${v}`);
    }
    const res = await this.runner.run(args, { cwd: workspacePath, env: { VERCEL_TOKEN: this.token } });
    if (res.exitCode !== 0) throw new Error(`vercel deploy failed (exit ${res.exitCode}): ${(res.stderr || res.stdout).slice(0, 400)}`);
    const url = firstVercelUrl(res.stdout, res.stderr);
    if (!url) throw new Error(`vercel deploy: no deployment URL in output: ${(res.stdout || res.stderr).slice(0, 200)}`);
    return { url, hostRef: project };
  }

  async teardown(hostRef: string): Promise<void> {
    if (!this.token) throw new Error("VercelHostProvider: missing VERCEL_TOKEN");
    const args = [...this.vercelBin, "remove", hostRef, "--yes"];
    if (this.scope) args.push("--scope", this.scope);
    const res = await this.runner.run(args, { cwd: process.cwd(), env: { VERCEL_TOKEN: this.token } });
    if (res.exitCode !== 0) throw new Error(`vercel remove failed (exit ${res.exitCode}): ${(res.stderr || res.stdout).slice(0, 300)}`);
  }
}
