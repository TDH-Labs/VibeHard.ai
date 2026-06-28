/**
 * Build sandbox (production-readiness loop, EPIC #32 — the #1 platform blocker). Untrusted, generated
 * app code (npm build scripts, the app's own server boot) must NEVER execute on the platform host. This
 * runs a generated app's BUILD + BOOT in an isolated, ephemeral Fly machine: deploy to a throwaway Fly
 * app → HTTP-probe it → ALWAYS tear it down. Only the build/boot is sandboxed; the gate scanners
 * (semgrep/gitleaks/trivy) read source as data, so they stay on-host safely.
 *
 * Composes the already-tested HostProvider (FlyHostProvider: deploy + teardown), so this orchestration
 * is unit-tested with fakes — no real Fly resources spun up in tests. A LIVE run does create (briefly)
 * + destroy a Fly machine, which has a cost; the verify-gate wiring + cost controls are the next step.
 */
import type { HostProvider } from "./types.ts";
import { isUp } from "../gate/verify.ts";

export interface SandboxResult {
  /** the app booted and served a healthy (2xx) response in the isolated machine */
  ok: boolean;
  status: number;
  url: string | null;
  /** error detail when the deploy/build failed (never the app's secrets) */
  log: string;
}

export interface FlySandboxDeps {
  /** ephemeral deploy + teardown seam (FlyHostProvider in prod; a fake in tests) */
  host: HostProvider;
  /** HTTP probe (injected for tests) */
  fetchImpl?: (url: string) => Promise<{ status: number }>;
  /** ephemeral app-name generator (injected so tests are deterministic) */
  name?: () => string;
  /** paths to try until one is healthy */
  probePaths?: string[];
}

/**
 * Run `workspacePath` (a generated app with a Dockerfile) in an isolated, ephemeral Fly machine and
 * report whether it boots. Tears the machine down unconditionally (even on probe failure or a deploy
 * error) so a sandbox run never leaves resources behind. Returns ok=false (never throws) on any failure.
 */
export async function runInFlySandbox(workspacePath: string, env: Record<string, string>, deps: FlySandboxDeps): Promise<SandboxResult> {
  const doFetch = deps.fetchImpl ?? (async (u: string) => ({ status: (await fetch(u)).status }));
  const paths = deps.probePaths ?? ["/", "/health", "/api/health"];
  const ephemeral = (deps.name ?? (() => `vibehard-sbx-${Date.now().toString(36)}`))();
  let hostRef: string | null = null;
  try {
    const dep = await deps.host.deploy(workspacePath, env, ephemeral);
    hostRef = dep.hostRef;
    let status = 0;
    for (const p of paths) {
      try {
        status = (await doFetch(`${dep.url}${p}`)).status;
        if (isUp(status)) break;
      } catch {
        /* this path unreachable yet — try the next */
      }
    }
    return { ok: isUp(status), status, url: dep.url, log: isUp(status) ? "" : `app did not serve a healthy response (last status ${status})` };
  } catch (e) {
    return { ok: false, status: 0, url: null, log: e instanceof Error ? e.message : String(e) };
  } finally {
    if (hostRef) {
      try {
        await deps.host.teardown(hostRef); // ALWAYS destroy the ephemeral machine
      } catch {
        /* best-effort teardown — never mask the sandbox result */
      }
    }
  }
}
