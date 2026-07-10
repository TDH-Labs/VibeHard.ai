/**
 * Core types — the typed contract the whole system speaks (PROJECT_BRIEF.md §11–12).
 * The gate contract (Severity/Finding/GateVerdict/Gate + isBlocking/verdictOf/notApplicable)
 * now lives in @vibehard/gate-check (2026-07-10 extraction) — re-exported here so every
 * existing internal import path (`../types.ts`, `../../types.ts`, …) keeps working unchanged.
 */

export type { Severity, Finding, GateVerdict, Gate } from "@vibehard/gate-check";
export { isBlocking, verdictOf, notApplicable } from "@vibehard/gate-check";

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
