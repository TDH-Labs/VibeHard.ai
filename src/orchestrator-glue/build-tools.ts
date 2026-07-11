/**
 * The production `BuildTools` — the orchestrator's hands, backed by the real pipeline. This is
 * VibeHard's own implementation of `@vibehard/orchestrator`'s `BuildTools` interface (2026-07-10
 * extraction: the orchestrator's brain moved to the package; this glue — which reaches into
 * `diagnose/`, `gate/`, `.vibehard/` state — stays here since it's VibeHard-specific, not
 * portable orchestrator code).
 * status/why are INSTANT (the static `diagnose`), so a "what's up?" is answered immediately;
 * retry dispatches the actual auto-fix loop through the SAME RunPipeline seam buildStream() uses
 * (build-substrate W4 — local subprocess by default, an E2B BuildWorker sandbox when
 * VIBEHARD_BUILD_WORKER=e2b) and acks immediately, not blocking the chat; ship runs
 * the DEPLOY gate to report shippability (the orchestrator already gated the human confirm).
 * setModel sets the per-stage override env for subsequent runs.
 */
import type { BuildTools } from "@vibehard/orchestrator";
import { diagnose, formatDiagnosis } from "../diagnose/diagnose.ts";
import { deployGate } from "../gate/index.ts";
import type { RunPipeline } from "../build-substrate/build-dispatcher.ts";
import { operatorLLMKey, type BuildEnvParts } from "../build-substrate/build-env.ts";

const HEARTBEAT_MS = 5 * 60 * 1000;
const MAX_HEARTBEATS = 6; // ~30 minutes of periodic pings, then we stop nagging (still watching for completion/failure)

export interface BuildToolsOptions {
  tenantId: string;
  app: string;
  /** invoked when a dispatched retry finishes (so the web layer can push a proactive message). */
  onRetryDone?: (ok: boolean, dir: string) => void;
  /** invoked every few minutes while a retry is still running, so a long fix loop never leaves
   *  the user in total silence. Never implies failure. */
  onRetryHeartbeat?: (dir: string, minutesElapsed: number) => void;
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
      // retry() only ever dispatches "fix" (never "ship"), and — matching this function's OWN
      // prior behavior (a blind `spawn` that inherited process.env wholesale, no per-tenant BYO
      // override) — doesn't apply the tenant's own LLM key here either; that asymmetry with
      // buildStream() is pre-existing, not something this workstream changes. It STILL needs
      // SOME LLM key to actually run the fixer, though (THE BUG found live 2026-07-11: `fix`'s
      // own TIER is "code", a real LLM call) — the old blind spawn got this for free via
      // process.env inheritance; operatorLLMKey() is the explicit equivalent.
      const e2bEnvParts: BuildEnvParts = {
        byoKey: operatorLLMKey(process.env) ?? null,
        integrations: {},
        integrationKeyNames: [],
        flyApiToken: process.env.FLY_API_TOKEN,
        vibehardSecretsKey: process.env.VIBEHARD_SECRETS_KEY,
        flyOrg: process.env.FLY_ORG,
        flyRegion: process.env.FLY_REGION,
      };
      runPipeline({ tenantId: opts.tenantId, app: opts.app, mode: "fix", workspace: dir, env: process.env as Record<string, string>, e2bEnvParts })
        .then((result) => finish(result.exitCode === 0))
        .catch(() => finish(false));
      return "On it — re-running the gate → fix → re-gate loop. I'll message you when it lands.";
    },

    async ship() {
      const result = await deployGate(dir);
      return result.sentinel !== null
        ? "✅ Passes the deploy gate — shippable. (Actual deploy wiring lands with the host adapter.)"
        : `❌ Not shippable yet — the deploy gate still blocks (${result.verdicts.filter((v) => v.status === "block").length} gate(s)). Say "why" or "retry".`;
    },

    setModel(stage, model) {
      if (!model) return `Tell me which model, e.g. "use kimi-k2.7-code for ${stage}".`;
      process.env[`VIBEHARD_MODEL_${stage.toUpperCase()}`] = model;
      return `Done — ${stage} will use ${model} on the next run.`;
    },
  };
}
