/**
 * Gated deploy path (PROJECT_BRIEF.md §11 "Deploy verdict" + the M2 task).
 *
 * This is where the gate sits BETWEEN generate and deploy. A generated workspace
 * reaches a real deploy target ONLY after M1's deterministic deploy gate writes
 * its HARD_VERIFY_PASS sentinel. Zero LLM in this path; the verdict is unskippable.
 *
 * The deploy target is a seam too (parallel to Engine): a real connector
 * (Netlify/Vercel/…) drops in behind `DeployTarget` later. M2 ships the gate and
 * a noop target — the sentinel precondition is the deliverable, not the connector.
 */
import { deployGate, type DeployResult } from "../gate/index.ts";

/** A place a passing build ships to. Real connectors implement this later. */
export interface DeployTarget {
  readonly name: string;
  deploy(workspacePath: string): Promise<{ url: string }>;
}

/** Default target: there is no real one yet, and a blocked gate must never reach
 *  a target anyway. If a passing build hits this, it's a config gap, not a deploy. */
export const noopDeployTarget: DeployTarget = {
  name: "noop",
  async deploy(): Promise<{ url: string }> {
    throw new Error("no deploy target configured (M2 ships the gate, not a connector)");
  },
};

/** Injectable gate runner — defaults to the real M1 deploy gate; tests inject a
 *  fake to stay fast (no Docker). */
export type DeployGateFn = (workspacePath: string) => Promise<DeployResult>;

export interface GatedDeployResult {
  deployed: boolean;
  /** The deterministic gate verdict that decided it. */
  verdict: DeployResult;
  /** Live URL if deployed; null if the gate refused. */
  url: string | null;
  reason: string;
}

/**
 * Run the deploy gate, then deploy IFF it passed. The target is never invoked on
 * a blocked verdict — that's the whole point. Returns a typed outcome the UI/
 * orchestrator can render (and that flows into the escalation packet in M3).
 */
export async function gatedDeploy(
  workspacePath: string,
  target: DeployTarget = noopDeployTarget,
  gate: DeployGateFn = deployGate,
): Promise<GatedDeployResult> {
  const verdict = await gate(workspacePath);

  if (!verdict.passed) {
    const blocked = verdict.verdicts.filter((v) => v.status === "block").map((v) => v.gate);
    return {
      deployed: false,
      verdict,
      url: null,
      reason: `deploy refused — gate(s) blocked: ${blocked.join(", ") || "unknown"}; no sentinel written`,
    };
  }

  const { url } = await target.deploy(workspacePath);
  return { deployed: true, verdict, url, reason: `deployed via ${target.name}` };
}
