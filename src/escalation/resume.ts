/**
 * Resume after review (PROJECT_BRIEF.md §8 "→ resume"). The final leg of the
 * escalation hand-off: re-run the gate (so any engineer FIX is re-checked by the
 * gate, never trusted on the human's word — §11), apply justified WAIVERS, stamp
 * the deterministic sentinel, and deploy — or re-escalate with a fresh packet.
 *
 * The gate is injectable so this is unit-testable without Docker; in production it
 * defaults to the real chain. Layering stays one-way: escalation depends on the
 * gate, never the reverse.
 */
import type { Finding, Gate } from "../types.ts";
import { runGate, stampSentinel, type PipelineResult } from "../gate/index.ts";
import { noopDeployTarget, type DeployTarget } from "../engine/deploy.ts";
import { applyWaivers, type Waiver } from "./review.ts";
import { buildEscalationPacket, type EscalationPacket } from "./packet.ts";

export interface ResumeOutcome {
  deployed: boolean;
  passed: boolean;
  url: string | null;
  /** Findings a justified human waived this round — audit record. */
  waived: Finding[];
  /** A fresh packet when still blocked after review; null when deployed. */
  escalation: EscalationPacket | null;
  reason: string;
}

export type GateRunner = (workspacePath: string) => Promise<PipelineResult>;

export interface ResumeOptions {
  target?: DeployTarget;
  gates?: Gate[];
  /** Override the gate runner (tests inject a fake to stay Docker-free). */
  gate?: GateRunner;
  now?: string;
}

export async function resumeDeploy(
  workspacePath: string,
  waivers: Waiver[],
  opts: ResumeOptions = {},
): Promise<ResumeOutcome> {
  const runner: GateRunner = opts.gate ?? ((p) => runGate(p, opts.gates));

  const fresh = await runner(workspacePath); // re-checks any fixes the engineer made
  const adjusted = applyWaivers(fresh.verdicts, waivers); // honor justified approvals
  await stampSentinel(workspacePath, adjusted.passed); // ratchet holds through resume

  if (!adjusted.passed) {
    const escalation = await buildEscalationPacket(adjusted.verdicts, workspacePath, {
      reason: "residual blocking findings after review",
      now: opts.now,
    });
    return {
      deployed: false,
      passed: false,
      url: null,
      waived: adjusted.waived,
      escalation,
      reason: "still blocked after review — re-escalated",
    };
  }

  const target = opts.target ?? noopDeployTarget;
  const { url } = await target.deploy(workspacePath);
  return {
    deployed: true,
    passed: true,
    url,
    waived: adjusted.waived,
    escalation: null,
    reason: `deployed via ${target.name}; ${adjusted.waived.length} finding(s) waived`,
  };
}
