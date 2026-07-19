/**
 * The production `BuildTools` — the orchestrator's hands, backed by the real pipeline. This is
 * VibeHard's own implementation of `@vibehard/orchestrator`'s `BuildTools` interface (2026-07-10
 * extraction: the orchestrator's brain moved to the package; this glue — which reaches into
 * `diagnose/`, `gate/`, `.vibehard/` state — stays here since it's VibeHard-specific, not
 * portable orchestrator code).
 * status/why are INSTANT (the static `diagnose`), so a "what's up?" is answered immediately;
 * retry/ship both dispatch through the SAME RunPipeline seam buildStream() uses (build-substrate
 * W4 — local subprocess by default, an E2B BuildWorker sandbox when VIBEHARD_BUILD_WORKER=e2b)
 * and ack immediately, not blocking the chat. setModel sets the per-stage override env for
 * subsequent runs.
 */
import type { BuildTools } from "@vibehard/orchestrator";
import { diagnose, formatDiagnosis } from "../diagnose/diagnose.ts";
import type { RunPipeline } from "../build-substrate/build-dispatcher.ts";
import { operatorLLMKey, type BuildEnvParts } from "../build-substrate/build-env.ts";

const HEARTBEAT_MS = 5 * 60 * 1000;
const MAX_HEARTBEATS = 6; // ~30 minutes of periodic pings, then we stop nagging (still watching for completion/failure)

export interface BuildToolsOptions {
  tenantId: string;
  app: string;
  /** Checked before EITHER retry or ship dispatches — return a reason to refuse (a build is
   *  already running for this tenant, or the platform is at capacity), or null to allow.
   *  THE BUG THIS CLOSES (flagged when build-substrate started, never actually closed until
   *  now): retry()/ship() had no guard at all, so a chat "retry" while an SSE-driven
   *  buildStream() was mid-flight could dispatch a SECOND, concurrent cli.ts run against the
   *  exact same workspace — the same race isBuildRunning()/atBuildCapacity() already close for
   *  buildStream()'s own two HTTP call sites, just never extended to this third one. */
  guard?: () => Promise<string | null>;
  /** Marks the durable build state "running" right before EITHER dispatch — mirrors
   *  buildStream()'s own bookkeeping, which retry()/ship() previously had none of: the tenant's
   *  dashboard and isBuildRunning() both need to see a chat-dispatched build as running, not
   *  just an SSE-dispatched one. */
  onDispatchStart?: () => Promise<void>;
  /** invoked when a dispatched retry finishes (so the web layer can push a proactive message
   *  and finalize the durable build status). */
  onRetryDone?: (ok: boolean, dir: string) => void;
  /** invoked every few minutes while a retry is still running, so a long fix loop never leaves
   *  the user in total silence. Never implies failure. */
  onRetryHeartbeat?: (dir: string, minutesElapsed: number) => void;
  /** invoked when a dispatched ship finishes. */
  onShipDone?: (ok: boolean, dir: string) => void;
  /** THE BUG THIS CLOSES: retry()/ship() previously passed no onLog to runPipeline at all, so
   *  a chat-dispatched build's output went nowhere — the local-spawn path silently discarded it
   *  (localSpawnPipeline only calls onLog if set), and even on the E2B path (where output is
   *  ALWAYS durably teed into BuildLogStore regardless of this callback) nothing here ever
   *  scanned it for the ::held/LIVE → markers buildStream()'s own runStep already captures.
   *  A chat-triggered ship that went live had no way to tell the tenant the URL; a chat-
   *  triggered build that held had no way to capture the ticket id. */
  onLog?: (line: string) => void;
}

/** The explicit, minimal env allowlist for a chat-dispatched retry/ship (SPEC decision #8) —
 *  matching this function's OWN prior behavior (a blind spawn that inherited process.env
 *  wholesale, no per-tenant BYO override); that asymmetry with buildStream() is pre-existing,
 *  not something this module changes. Still needs SOME LLM key to actually run the fixer (THE
 *  BUG found live 2026-07-11: `fix`'s own TIER is "code", a real LLM call) — the old blind spawn
 *  got this for free via process.env inheritance; operatorLLMKey() is the explicit equivalent. */
function chatDispatchEnvParts(): BuildEnvParts {
  return {
    byoKey: operatorLLMKey(process.env) ?? null,
    integrations: {},
    integrationKeyNames: [],
    flyApiToken: process.env.FLY_API_TOKEN,
    vibehardSecretsKey: process.env.VIBEHARD_SECRETS_KEY,
    flyOrg: process.env.FLY_ORG,
    flyRegion: process.env.FLY_REGION,
    // Found live 2026-07-19 (acceptance test prompt C's chat "ship"): every sandboxed build runs
    // VIBEHARD_MANAGED=1 (assembleBuildEnv), so `ship` needs this to actually provision a
    // Supabase project — see build-env.ts's supabaseManagementToken doc for the full story.
    supabaseManagementToken: process.env.SUPABASE_ACCESS_TOKEN ?? process.env.SUPABASE_PAT,
  };
}

export function realBuildTools(dir: string, runPipeline: RunPipeline, opts: BuildToolsOptions): BuildTools {
  return {
    async status() {
      const d = diagnose(dir);
      return formatDiagnosis(d);
    },

    async why() {
      const d = diagnose(dir);
      const s = d.state.heldTicket ? `Held (${d.state.heldTicket}). ` : "";
      const deps = [...d.deps.undeclaredImports, ...d.deps.missingFromLock];
      if (deps.length) return `${s}Dependency issue: ${deps.join(", ")} — I can fix that deterministically; say "retry".`;
      return `${s}No dependency problem. For the exact build error say nothing else is cached — I'll run a build check (say "retry" to re-run the loop, which fixes + re-gates).`;
    },

    async retry() {
      const refusal = await opts.guard?.();
      if (refusal) return refusal;
      await opts.onDispatchStart?.();
      // Dispatch through runPipeline; report progress via onRetryDone, not by blocking the chat —
      // deliberately NOT awaited here (matches the old detached-spawn semantics: retry() acks
      // immediately, the actual work continues in the background). A pipeline rejection (e.g. a
      // dispatch-time infra failure) is caught and reported as a failed retry, same as any other
      // nonzero exit — the orchestrator's promise to "message you when it lands" must always be
      // kept, never left hanging on an unhandled rejection.
      let settled = false;
      let heartbeats = 0;
      const timer = opts.onRetryHeartbeat
        ? setInterval(() => {
            if (settled || ++heartbeats > MAX_HEARTBEATS) return;
            opts.onRetryHeartbeat!(dir, heartbeats * (HEARTBEAT_MS / 60_000));
          }, HEARTBEAT_MS)
        : null;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        opts.onRetryDone?.(ok, dir);
      };
      runPipeline({ tenantId: opts.tenantId, app: opts.app, mode: "fix", workspace: dir, env: process.env as Record<string, string>, e2bEnvParts: chatDispatchEnvParts(), onLog: opts.onLog })
        .then((result) => finish(result.exitCode === 0))
        .catch(() => finish(false));
      return "On it — re-running the gate → fix → re-gate loop. I'll message you when it lands.";
    },

    async ship() {
      const refusal = await opts.guard?.();
      if (refusal) return refusal;
      await opts.onDispatchStart?.();
      // THE BUG THIS CLOSES: this used to be deployGate(dir) — a CHECK, not a deploy. The
      // orchestrator already gates "ship" behind an explicit human confirm (Orchestrator's own
      // CONSEQUENTIAL set); a tenant confirming "yes" got back "shippable" and nothing actually
      // happened. Now dispatches the real `ship` mode through the same seam retry() uses —
      // cli.ts's own `ship` command runs deployGate() FIRST (same gate check as before, still
      // never deploys unverified code) and only proceeds to a real deploy if it passes.
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        opts.onShipDone?.(ok, dir);
      };
      runPipeline({ tenantId: opts.tenantId, app: opts.app, mode: "ship", workspace: dir, env: process.env as Record<string, string>, e2bEnvParts: chatDispatchEnvParts(), onLog: opts.onLog })
        .then((result) => finish(result.exitCode === 0))
        .catch(() => finish(false));
      return "On it — gating, then deploying. I'll message you when it's live.";
    },

    setModel(stage, model) {
      if (!model) return `Tell me which model, e.g. "use kimi-k2.7-code for ${stage}".`;
      process.env[`VIBEHARD_MODEL_${stage.toUpperCase()}`] = model;
      return `Done — ${stage} will use ${model} on the next run.`;
    },
  };
}
