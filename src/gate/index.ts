/**
 * Re-export shim (2026-07-10 extraction) — the gate chain now lives in @vibehard/gate-check.
 * Kept at this path so every existing internal import (`../gate/index.ts`) needs zero changes.
 *
 * GATES / FAST_GATES / runGate / deployGate are deliberately NOT blind re-exports: the package's
 * own bare `verifyGate`/`completenessGate` degrade for standalone use (no sandbox → local docker;
 * no reviewer → fails closed). This file IS VibeHard's gate-wiring layer — it binds the real Fly
 * sandbox (substrate/fly*.ts) and the real LLM completeness reviewer (configForStage + defaultModelFactory)
 * back in, so production behavior is unchanged from before the extraction.
 */
import {
  type Gate,
  type GateVerdict,
  type VerifyDeps,
  createVerifyGate,
  createFastVerifyGate,
  createCompletenessGate,
  llmFunctionalReviewer,
  sastGate,
  secretsGate,
  depvulnGate,
  rlsGate,
  migrateGate,
  rlsEnforceGate,
  complianceGate,
  piiGate,
  prodReadinessGate,
  proptestGate,
  runGate as runGateBare,
  deployGate as deployGateBare,
} from "@vibehard/gate-check";
import { FlyHostProvider } from "../substrate/fly.ts";
import { runInFlySandbox } from "../substrate/fly-sandbox.ts";
import { runInFlyExecSandbox, type FlyExecSandboxDeps } from "../substrate/fly-exec-sandbox.ts";
import { configForStage } from "../config/models.ts";
import { defaultModelFactory } from "../engine/bolt/driver.ts";

/** The real Fly sandbox, wired exactly as before the extraction: a real FlyHostProvider when
 *  FLY_API_TOKEN is set (production); undefined otherwise (local docker fallback — dev/CI/tests,
 *  none of which set the token). */
const verifyDeps: VerifyDeps = {
  flyHost: process.env.FLY_API_TOKEN ? new FlyHostProvider() : undefined,
  runSandbox: runInFlySandbox,
  runExecSandbox: (projectPath, dockerfile, cmd, deps) => runInFlyExecSandbox(projectPath, dockerfile, cmd, deps as FlyExecSandboxDeps | undefined),
};

const realVerifyGate = createVerifyGate(verifyDeps);
const realFastVerifyGate = createFastVerifyGate(verifyDeps);
const realCompletenessGate = createCompletenessGate({
  reviewer: llmFunctionalReviewer({ modelFactory: defaultModelFactory, config: configForStage("functest") }),
});

/** The default gate chain — same composition/order as before the extraction (see package's own
 *  index.ts docstring for the reasoning), with the real Fly-verify + real LLM-completeness gates
 *  substituted in for the package's bare/degraded defaults. */
export const GATES: Gate[] = [sastGate, secretsGate, depvulnGate, rlsGate, migrateGate, rlsEnforceGate, complianceGate, piiGate, prodReadinessGate, proptestGate, realVerifyGate, realCompletenessGate];

/** The FAST chain for the inner fix loop — same as GATES but the cheap in-place-build verify proxy,
 *  no completeness (unchanged from before the extraction). */
export const FAST_GATES: Gate[] = [sastGate, secretsGate, depvulnGate, rlsGate, migrateGate, rlsEnforceGate, complianceGate, piiGate, prodReadinessGate, proptestGate, realFastVerifyGate];

export async function runGate(projectPath: string, gates: Gate[] = GATES, onVerdict?: (v: GateVerdict) => void) {
  return runGateBare(projectPath, gates, onVerdict);
}

export async function deployGate(projectPath: string, gates: Gate[] = GATES) {
  return deployGateBare(projectPath, gates);
}

// Everything else (the gate contract types, individual gate functions, sentinel helpers, the
// vendored spec/backend-model/proptest-validate contracts, subprocess infra) is unchanged from
// the package — passed straight through. Local declarations above (GATES/FAST_GATES/runGate/
// deployGate) shadow the package's same-named exports per ES module semantics; no conflict.
export * from "@vibehard/gate-check";
