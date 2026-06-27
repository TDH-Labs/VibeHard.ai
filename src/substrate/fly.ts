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
import { existsSync, rmSync, writeFileSync } from "node:fs";
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

/** Client-side / public env vars that are safe in a plaintext config file (H6 fix).
 *  NEXT_PUBLIC_* and VITE_* are intentionally embedded in the browser bundle.
 *  SUPABASE_URL and SUPABASE_ANON_KEY are RLS-gated public values (service-role excluded upstream).
 *  Everything else (STRIPE_SECRET_KEY, API tokens, …) is a secret → fly secrets set. */
export function isPublicEnvVar(key: string): boolean {
  return (
    key.startsWith("NEXT_PUBLIC_") ||
    key.startsWith("VITE_") ||
    key === "SUPABASE_URL" ||
    key === "SUPABASE_ANON_KEY" ||
    key === "NODE_ENV" ||
    key === "PORT"
  );
}

/** Partition env into { publicEnv, secretEnv }. publicEnv → fly.toml [env]; secretEnv → fly secrets set. */
export function partitionEnv(env: Record<string, string>): { publicEnv: Record<string, string>; secretEnv: Record<string, string> } {
  const publicEnv: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (isPublicEnvVar(k)) publicEnv[k] = v;
    else secretEnv[k] = v;
  }
  return { publicEnv, secretEnv };
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
    // fly.toml carries the [env] block (url + anon — NEVER the service key). Write it ONLY for the
    // duration of the deploy and remove it after: a secret-bearing manifest must never linger in the
    // gated workspace, or it trips the secrets gate on the next ship (a real recurrence, since we
    // regenerate fly.toml every deploy and the app config lives on Fly's side once deployed).
    // H6 fix: never write third-party secrets (STRIPE_SECRET_KEY, etc.) to plaintext fly.toml.
    // Public vars (NEXT_PUBLIC_*, VITE_*, SUPABASE_URL/ANON_KEY) → [env]; secrets → fly secrets set.
    const { publicEnv, secretEnv } = partitionEnv(env);
    const flyTomlPath = join(workspacePath, "fly.toml");
    writeFileSync(flyTomlPath, renderFlyToml(app, this.region, this.internalPort, publicEnv));
    const flyEnv = { FLY_API_TOKEN: this.token };
    try {
      // best-effort create (harmlessly non-zero if the app already exists → idempotent redeploy)
      await this.runner.run([...this.flyBin, "apps", "create", app, "--org", this.org], { cwd: workspacePath, env: flyEnv });
      // Inject secrets before deploy so they're available at container start (Fly resolves them server-side).
      if (Object.keys(secretEnv).length > 0) {
        const pairs = Object.entries(secretEnv).map(([k, v]) => `${k}=${v}`);
        await this.runner.run([...this.flyBin, "secrets", "set", "--app", app, "--stage", ...pairs], { cwd: workspacePath, env: flyEnv });
      }
      const res = await this.runner.run([...this.flyBin, "deploy", "--app", app, "--remote-only", "--ha=false"], { cwd: workspacePath, env: flyEnv });
      if (res.exitCode !== 0) throw new Error(`fly deploy failed (exit ${res.exitCode}): ${(res.stderr || res.stdout).slice(0, 400)}`);
      return { url: `https://${app}.fly.dev`, hostRef: app };
    } finally {
      try {
        rmSync(flyTomlPath, { force: true });
      } catch {
        /* best-effort cleanup — never mask the deploy result */
      }
    }
  }

  async teardown(hostRef: string): Promise<void> {
    if (!this.token) throw new Error("FlyHostProvider: missing FLY_API_TOKEN");
    const res = await this.runner.run([...this.flyBin, "apps", "destroy", hostRef, "--yes"], { cwd: process.cwd(), env: { FLY_API_TOKEN: this.token } });
    if (res.exitCode !== 0) throw new Error(`fly apps destroy failed (exit ${res.exitCode}): ${(res.stderr || res.stdout).slice(0, 300)}`);
  }
}
