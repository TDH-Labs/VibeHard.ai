/**
 * Core types — the typed contract the whole system speaks (PROJECT_BRIEF.md §11–12).
 * Deterministic gates produce these; the LLM/engine layer only ever fills inputs.
 */

export type Severity = "critical" | "high" | "medium" | "low";

/** One concrete problem found by a scanner or static check. Structured on purpose —
 *  the escalation packet and the UI need the detail, never a flattened string. */
export interface Finding {
  tool: string; // "semgrep" | "gitleaks" | "rls" | "verify"
  ruleId: string;
  severity: Severity;
  file: string;
  line?: number;
  message: string;
}

/** A gate's deterministic verdict. `escalate` is reserved for the human layer. */
export interface GateVerdict {
  gate: string;
  /** "n/a" = the gate had nothing to check (e.g. no spec to classify, no data model to prove RLS on).
   *  Distinct from "pass" on PURPOSE — a vacuous pass must not read as "verified" (audit H4). It does
   *  not block a deploy, but it does not count as a verified pass either. */
  status: "pass" | "block" | "escalate" | "n/a";
  findings: Finding[];
  blocking: number; // count of findings that force a block
  ranAt: string; // ISO timestamp, stamped by the caller
}

/** A deterministic gate: code in (a project dir), verdict out. Engine-agnostic. */
export interface Gate {
  name: string;
  run(projectPath: string): Promise<GateVerdict>;
}

// ── Engine seam (M2+) — design-for-future, NO implementation in M1 ───────────
// The generation runtime behind the front door (bolt.diy fork / Goose / Claude
// SDK). See PROJECT_BRIEF.md §13. Contract: the engine is a STATELESS code
// generator. All durable state (spec, files, gate results, transcript) lives on
// OUR side and is passed in. The UI/orchestrator consume the normalized
// EngineEvent stream — never an engine's native API — so swapping engines is
// invisible to the user. To add an engine: implement these interfaces + a
// normalizer; nothing above the seam changes. Build a 2nd adapter only on a
// concrete need (cost routing / lock-in) — never speculatively.

/** The only events the UI/orchestrator ever see. Each engine's native protocol
 *  is normalized into this set, which is what decouples UX from the engine. */
export type EngineEvent =
  | { type: "thinking"; text: string }
  | { type: "file-changed"; path: string; action: "create" | "edit" | "delete" }
  | { type: "message"; text: string }
  | { type: "preview-ready"; url: string }
  | { type: "error"; message: string }
  | { type: "done" };

/** Which model/provider to use — passed IN, so cost/provider routing stays OURS.
 *  Secrets are injected by the host (env/secret manager), never carried here. */
export interface EngineConfig {
  provider: string; // "anthropic" | "openai" | "openrouter" | …
  model: string;
}

/** A live generation session over one project workspace. */
export interface EngineSession {
  /** Send a prompt; receive a normalized event stream. */
  prompt(text: string): AsyncIterable<EngineEvent>;
  /** Absolute path to the generated workspace — exactly what the gates scan. */
  workspacePath(): string;
  /** Release engine resources; our durable state persists independently. */
  dispose(): Promise<void>;
}

/** The swappable engine. Implement this (+ a normalizer) to add an engine. */
export interface Engine {
  readonly name: string;
  /** Open a session over an existing (possibly empty) project workspace. */
  startSession(projectPath: string, config: EngineConfig): Promise<EngineSession>;
}

/** A finding is blocking if it's high/critical severity (or any leaked secret). */
export function isBlocking(f: Finding): boolean {
  return f.severity === "critical" || f.severity === "high" || f.tool === "gitleaks";
}

/** Roll a gate's findings into a verdict. Pure — unit-testable. */
export function verdictOf(gate: string, findings: Finding[], ranAt: string): GateVerdict {
  const blocking = findings.filter(isBlocking).length;
  return { gate, status: blocking > 0 ? "block" : "pass", findings, blocking, ranAt };
}

/** A gate with NOTHING to check (not "verified OK" — there was simply nothing applicable). Use this
 *  instead of an empty `verdictOf` so a no-op never masquerades as a real pass (audit H4 / B3). */
export function notApplicable(gate: string, ranAt: string): GateVerdict {
  return { gate, status: "n/a", findings: [], blocking: 0, ranAt };
}
