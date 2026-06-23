/**
 * Escalation hand-off (PROJECT_BRIEF.md §8 "Option B", §11). The deterministic
 * mechanism that turns a blocked deploy into a routed, pre-localized review packet
 * and resumes once a human has judged it. The human/marketplace layer (sourcing
 * and scheduling engineers — §7) sits ABOVE this; this is the code half.
 */
export { routeFinding, type Specialty } from "./routing.ts";
export {
  buildEscalationPacket,
  findingRef,
  type CodeSlice,
  type EscalationItem,
  type EscalationPacket,
} from "./packet.ts";
export {
  applyWaivers,
  waiversFromDecisions,
  type ReviewDecision,
  type ReviewVerdict,
  type Waiver,
  type WaivedResult,
} from "./review.ts";
export { resumeDeploy, type GateRunner, type ResumeOptions, type ResumeOutcome } from "./resume.ts";
export {
  LocalEscalationSink,
  claimTicket,
  openTicket,
  resolveTicket,
  ticketId,
  type EscalationSink,
  type EscalationTicket,
  type TicketState,
} from "./queue.ts";
export { GitHubEscalationSink, type GitHubEscalationSinkOptions } from "./github.ts";
