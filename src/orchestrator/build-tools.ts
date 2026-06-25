/**
 * The production `BuildTools` — the orchestrator's hands, backed by the real pipeline.
 * status/why are INSTANT (the static `diagnose`), so a "what's up?" is answered immediately;
 * retry spawns the actual auto-fix loop (detached, like a real build) and acks; ship runs
 * the DEPLOY gate to report shippability (the orchestrator already gated the human confirm).
 * setModel sets the per-stage override env for subsequent runs.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { BuildTools } from "./orchestrator.ts";
import { diagnose, formatDiagnosis } from "../diagnose/diagnose.ts";
import { deployGate } from "../gate/index.ts";

const CLI = join(import.meta.dir, "..", "cli.ts");

export interface BuildToolsOptions {
  /** invoked when a spawned retry finishes (so the web layer can push a proactive message). */
  onRetryDone?: (ok: boolean, dir: string) => void;
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
      // spawn the real loop detached; report progress via onRetryDone, not by blocking the chat
      const child = spawn("bun", [CLI, "fix", dir], { detached: true, stdio: "ignore" });
      child.unref();
      if (opts.onRetryDone) child.on("exit", (code) => opts.onRetryDone!(code === 0, dir));
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
