/**
 * FlyHostProvider — a CONTAINER HostProvider (Fly.io). Where the Vercel provider is
 * JavaScript-native, this deploys ANY web server in a Dockerfile — Python, Go, Rust — so
 * it's the single unlock for the *deploy* side of language expansion (the gate + Supabase
 * are already language-agnostic). Same HostProvider seam, same injectable command runner
 * (so arg assembly + the generated fly.toml unit-test with a fake — no flyctl, no network).
 * `--remote-only` builds the image on Fly's builders, so no local Docker is required.
 *
 * Token via FLY_API_TOKEN env, NEVER argv. Only the orchestrator's url+anon land in the
 * app's env (the service-role key never reaches here — §16/R6.2).
 */
import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HostProvider } from "./types.ts";
import { bunRunner, sanitizeProjectName, type CommandRunner } from "./vercel.ts";

export interface FlyHostOptions {
  token?: string; // FLY_API_TOKEN
  org?: string; // default "personal"
  region?: string; // default "iad"
  internalPort?: number; // the port the app listens on (default 8080)
  runner?: CommandRunner;
  flyBin?: string[]; // default ["fly"]
}

/** Minimal fly.toml: build from the workspace Dockerfile, the injected env, one cheap auto-stopping machine. */
export function renderFlyToml(app: string, region: string, internalPort: number, env: Record<string, string>): string {
  const envLines = Object.entries(env)
    .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
    .join("\n");
  return [
    `app = ${JSON.stringify(app)}`,
    `primary_region = ${JSON.stringify(region)}`,
    "",
    "[build]",
    "",
    "[env]",
    envLines,
    "",
    "[http_service]",
    `  internal_port = ${internalPort}`,
    "  force_https = true",
    "  auto_stop_machines = true",
    "  auto_start_machines = true",
    "  min_machines_running = 0",
    "",
  ].join("\n");
}

export class FlyHostProvider implements HostProvider {
  readonly name = "fly";
  private readonly token: string;
  private readonly org: string;
  private readonly region: string;
  private readonly internalPort: number;
  private readonly runner: CommandRunner;
  private readonly flyBin: string[];

  constructor(opts: FlyHostOptions = {}) {
    this.token = opts.token ?? process.env.FLY_API_TOKEN ?? "";
    this.org = opts.org ?? process.env.FLY_ORG ?? "personal";
    this.region = opts.region ?? process.env.FLY_REGION ?? "iad";
    this.internalPort = opts.internalPort ?? 8080;
    this.runner = opts.runner ?? bunRunner;
    this.flyBin = opts.flyBin ?? ["fly"];
  }

  async deploy(workspacePath: string, env: Record<string, string>, hostRef: string | null): Promise<{ url: string; hostRef: string }> {
    if (!this.token) throw new Error("FlyHostProvider: missing FLY_API_TOKEN");
    if (!existsSync(join(workspacePath, "Dockerfile"))) {
      throw new Error("FlyHostProvider: no Dockerfile in the workspace — a container deploy needs one (this is the per-language codegen's job)");
    }
    const app = hostRef ?? (sanitizeProjectName(basename(workspacePath)).slice(0, 30).replace(/-+$/, "") || "app");
    writeFileSync(join(workspacePath, "fly.toml"), renderFlyToml(app, this.region, this.internalPort, env));
    const flyEnv = { FLY_API_TOKEN: this.token };
    // best-effort create (harmlessly non-zero if the app already exists → idempotent redeploy)
    await this.runner.run([...this.flyBin, "apps", "create", app, "--org", this.org], { cwd: workspacePath, env: flyEnv });
    const res = await this.runner.run([...this.flyBin, "deploy", "--app", app, "--remote-only", "--ha=false"], { cwd: workspacePath, env: flyEnv });
    if (res.exitCode !== 0) throw new Error(`fly deploy failed (exit ${res.exitCode}): ${(res.stderr || res.stdout).slice(0, 400)}`);
    return { url: `https://${app}.fly.dev`, hostRef: app };
  }

  async teardown(hostRef: string): Promise<void> {
    if (!this.token) throw new Error("FlyHostProvider: missing FLY_API_TOKEN");
    const res = await this.runner.run([...this.flyBin, "apps", "destroy", hostRef, "--yes"], { cwd: process.cwd(), env: { FLY_API_TOKEN: this.token } });
    if (res.exitCode !== 0) throw new Error(`fly apps destroy failed (exit ${res.exitCode}): ${(res.stderr || res.stdout).slice(0, 300)}`);
  }
}
