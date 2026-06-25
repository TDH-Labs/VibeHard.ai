/**
 * Gate pipeline + deploy sentinel — runs the registered gates against a project,
 * aggregates verdicts, and (for deploy) writes the unskippable sentinel ONLY
 * when every gate passes. Engine-blind: it takes a directory of code, regardless
 * of what produced it. The deploy verdict is deterministic with zero LLM in the
 * path (PROJECT_BRIEF.md §11 "Deploy verdict", §13).
 */
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { Gate, GateVerdict } from "../types.ts";
import { sastGate } from "./sast.ts";
import { secretsGate } from "./secrets.ts";
import { depvulnGate } from "./depvuln.ts";
import { rlsGate } from "./rls.ts";
import { complianceGate } from "./compliance.ts";
import { piiGate } from "./pii.ts";
import { prodReadinessGate } from "./prod-readiness.ts";
import { verifyGate, fastVerifyGate } from "./verify.ts";
import { completenessGate } from "./completeness.ts";

/** The default gate chain. Source scanners run FIRST, on authored source; verify runs
 *  LAST because it builds the app (creating .next/dist/…) — keeping derived output out
 *  of the source scans (§11, §19). compliance and prod-readiness are
 *  classification/rigor-driven: a no-op unless the app's spec was persisted by the
 *  front-half, so they never fire on a project that didn't go through it. */
export const GATES: Gate[] = [sastGate, secretsGate, depvulnGate, rlsGate, complianceGate, piiGate, prodReadinessGate, verifyGate, completenessGate];

/** The FAST chain for the inner fix loop: same gates, but verify is the cheap in-place-build
 *  proxy (seconds, not the minutes of clean-room + container + boot probes). Iterate on this;
 *  the full GATES run ONCE at convergence to confirm the real artifact + no regression. */
export const FAST_GATES: Gate[] = [sastGate, secretsGate, depvulnGate, rlsGate, complianceGate, piiGate, prodReadinessGate, fastVerifyGate];

/** Relative path of the "all gates passed" sentinel within a project. */
export const SENTINEL_REL = ".gate/HARD_VERIFY_PASS";

export interface PipelineResult {
  verdicts: GateVerdict[];
  passed: boolean;
}

export interface DeployResult extends PipelineResult {
  /** Absolute path to the sentinel if written (passed); null if deploy is blocked. */
  sentinel: string | null;
}

export async function runGate(projectPath: string, gates: Gate[] = GATES, onVerdict?: (v: GateVerdict) => void): Promise<PipelineResult> {
  const verdicts: GateVerdict[] = [];
  for (const g of gates) {
    const v = await g.run(projectPath);
    onVerdict?.(v); // surface each gate's result the moment it lands (live per-gate progress)
    verdicts.push(v);
  }
  return { verdicts, passed: verdicts.every((v) => v.status === "pass") };
}

/**
 * The ratchet, in one place: write the sentinel iff `passed`, else remove a stale
 * one so a prior pass can never authorize a now-failing build. Shared by the
 * deploy gate and the escalation resume path so there is exactly one sentinel writer.
 */
export async function stampSentinel(projectPath: string, passed: boolean): Promise<string | null> {
  const sentinel = join(projectPath, SENTINEL_REL);
  if (passed) {
    await Bun.write(sentinel, `${new Date().toISOString()}\n`);
    return sentinel;
  }
  await rm(sentinel, { force: true });
  return null;
}

/**
 * The deploy gate. Runs the chain and stamps the sentinel ONLY if every gate
 * passes. Nothing deploys without this sentinel.
 */
export async function deployGate(projectPath: string, gates: Gate[] = GATES): Promise<DeployResult> {
  const result = await runGate(projectPath, gates);
  return { ...result, sentinel: await stampSentinel(projectPath, result.passed) };
}
