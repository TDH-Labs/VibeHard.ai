/**
 * The production `BuildTools` — the orchestrator's hands, backed by the real pipeline. This is
 * VibeHard's own implementation of `@vibehard/orchestrator`'s `BuildTools` interface (2026-07-10
 * extraction: the orchestrator's brain moved to the package; this glue — which reaches into
 * `diagnose/`, `gate/`, `.vibehard/` state, and spawns the CLI directly — stays here since it's
 * VibeHard-specific, not portable orchestrator code).
 * status/why are INSTANT (the static `diagnose`), so a "what's up?" is answered immediately;
 * retry spawns the actual auto-fix loop (detached, like a real build) and acks; ship runs
 * the DEPLOY gate to report shippability (the orchestrator already gated the human confirm).
 * setModel sets the per-stage override env for subsequent runs.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { BuildTools } from "@vibehard/orchestrator";
import { diagnose, formatDiagnosis } from "../diagnose/diagnose.ts";
import { deployGate } from "../gate/index.ts";

const CLI = join(import.meta.dir, "..", "cli.ts");
const HEARTBEAT_MS = 5 * 60 * 1000;
const MAX_HEARTBEATS = 6; // ~30 minutes of periodic pings, then we stop nagging (still watching for exit/error)

export interface BuildToolsOptions {
  /** invoked when a spawned retry finishes (so the web layer can push a proactive message). */
  onRetryDone?: (ok: boolean, dir: string) => void;
  /** invoked every few minutes while a retry is still running, so a long fix loop never leaves
   *  the user in total silence (a spawn failure alone used to hang forever — no error handler,
   *  no signal until `exit`, which never fires on a launch failure). Never implies failure. */
  onRetryHeartbeat?: (dir: string, minutesElapsed: number) => void;
}

export function realBuildTools(dir: string, opts: BuildToolsOptions = {}): BuildTools {
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
      // spawn the real loop detached; report progress via onRetryDone, not by blocking the chat.
      // A spawn failure (bad PATH, OOM, etc.) fires "error" but NEVER "exit" — without an error
      // handler that left the orchestrator's promise to "message you when it lands" permanently
      // unkept. The heartbeat covers the other silent failure mode: a child that neither exits
      // nor errors (hung / orphaned) leaves the user with zero signal for the life of the build.
      const child = spawn("bun", [CLI, "fix", dir], { detached: true, stdio: "ignore" });
      child.unref();
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
      child.on("exit", (code) => finish(code === 0));
      child.on("error", () => finish(false));
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
