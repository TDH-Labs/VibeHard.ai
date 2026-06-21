/**
 * Gate pipeline — runs the registered gates against a project and aggregates.
 * Engine-blind: it takes a directory of code, regardless of what produced it.
 * Secrets / RLS / verify gates land here next (same shape as sast).
 */
import type { Gate, GateVerdict } from "../types.ts";
import { sastGate } from "./sast.ts";
import { secretsGate } from "./secrets.ts";

/** The default security gate chain. Extend as gates are ported. */
export const GATES: Gate[] = [sastGate, secretsGate];

export interface PipelineResult {
  verdicts: GateVerdict[];
  passed: boolean;
}

export async function runGate(projectPath: string, gates: Gate[] = GATES): Promise<PipelineResult> {
  const verdicts: GateVerdict[] = [];
  for (const g of gates) verdicts.push(await g.run(projectPath));
  return { verdicts, passed: verdicts.every((v) => v.status === "pass") };
}
