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
import { rlsGate } from "./rls.ts";
import { verifyGate } from "./verify.ts";

/** The default security gate chain. Order mirrors gate-proof's deploy-gate.sh. */
export const GATES: Gate[] = [verifyGate, sastGate, secretsGate, rlsGate];

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

export async function runGate(projectPath: string, gates: Gate[] = GATES): Promise<PipelineResult> {
  const verdicts: GateVerdict[] = [];
  for (const g of gates) verdicts.push(await g.run(projectPath));
  return { verdicts, passed: verdicts.every((v) => v.status === "pass") };
}

/**
 * The deploy gate (the ratchet). Runs the chain and writes the sentinel ONLY if
 * every gate passes; on any block it removes a stale sentinel so a prior pass can
 * never authorize a now-failing build. Nothing deploys without this sentinel.
 */
export async function deployGate(projectPath: string, gates: Gate[] = GATES): Promise<DeployResult> {
  const result = await runGate(projectPath, gates);
  const sentinel = join(projectPath, SENTINEL_REL);
  if (result.passed) {
    await Bun.write(sentinel, `${new Date().toISOString()}\n`);
    return { ...result, sentinel };
  }
  await rm(sentinel, { force: true });
  return { ...result, sentinel: null };
}
