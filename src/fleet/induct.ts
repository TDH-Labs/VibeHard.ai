/**
 * INDUCTION (step 3): turn a promotable candidate — a gate failure that RECURRED across builds,
 * with verifier-gated evidence of the fixes that cleared it (step 1) — into a general, reusable
 * convention. The LLM PROPOSES the rule wording (abstracting away app-specifics); deterministic
 * code DISPOSES: the proposal lands in a REVIEW QUEUE (operator approval, never auto-live), and
 * approval both adds it to the store AND drops a regression fixture so a future convention can't
 * silently undo it. (LLM proposes, the gate + a human + the harness dispose — the safety rails.)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { configForStage } from "../config/models.ts";
import { defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import { tryExtractJsonObject } from "../spec/coerce.ts";
import type { EngineConfig } from "../types.ts";
import { addConvention, promotable, type Candidate, type Convention, type Phase } from "./fleet.ts";

const fleetDir = (): string => process.env.VIBEHARD_FLEET_DIR ?? join(homedir(), ".vibehard", "fleet");
const pendingPath = (): string => join(fleetDir(), "pending.json");
/** Where approved lessons drop a regression-log fixture (the harness lock). */
const fixturesDir = (): string => process.env.VIBEHARD_FIXTURES_DIR ?? join(import.meta.dir, "..", "..", "fixtures", "build-logs");

const PHASES: readonly Phase[] = ["planning", "codegen", "both"];

const INDUCT_SYSTEM = `You distill a RECURRING build failure (it failed many independent builds) plus the fixes that RESOLVED it into ONE general, reusable convention for an AI code generator.

Rules:
- Write a GENERAL rule that applies to ANY app on this stack — NOT a fix for one specific app. Abstract away app-specific names/files; never include a user's code or data.
- The rule must be ACTIONABLE at generation time ("do X / never Y") and tie to the failure it prevents.
- Pick the phase: "planning" (an architecture decision), "codegen" (a code-writing rule), or "both".

Return ONLY JSON: { "id": kebab-case-slug, "rule": string, "phase": "planning"|"codegen"|"both" }`;

function renderCandidate(c: Candidate): string {
  const evidence = (c.resolutions ?? []).map((r) => `- failed: ${r.message}\n  cleared by changing: ${r.files.join(", ")}`).join("\n");
  return `Recurring failure signal: ${c.signal} (stack: ${c.stack}, seen in ${c.builds} builds)\n\nFixes that cleared it (verifier-gated — each made the gate go green):\n${evidence || "(no captured fixes)"}\n\nDistill the convention.`;
}

/** Trust boundary: coerce the model's JSON into a valid Convention (or null). */
export function coerceConvention(raw: unknown, c: Candidate): Convention | null {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rule = typeof o.rule === "string" ? o.rule.trim() : "";
  if (rule.length < 12) return null;
  const id = typeof o.id === "string" && /^[a-z0-9-]+$/.test(o.id) ? o.id : `learned-${c.signal.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`.slice(0, 48);
  const phase: Phase = PHASES.includes(o.phase as Phase) ? (o.phase as Phase) : "codegen";
  return { id, stack: c.stack, phase, rule, addresses: c.signal, builds: c.builds };
}

export interface Inductor {
  (candidate: Candidate): Promise<Convention | null>;
}
export interface InductorOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

/** The live inductor — one model call per candidate. */
export function llmInductor(opts: InductorOptions = {}): Inductor {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config = opts.config ?? configForStage("review"); // a reasoning model judges generality
  return async (candidate) => {
    try {
      const { text } = await generateText({ model: modelFactory(config), system: INDUCT_SYSTEM, prompt: renderCandidate(candidate), maxOutputTokens: 4000, abortSignal: AbortSignal.timeout(60_000) });
      return coerceConvention(tryExtractJsonObject(text), candidate);
    } catch {
      return null; // a transient failure just skips this candidate — never crashes induction
    }
  };
}

function readPending(): Convention[] {
  try {
    return JSON.parse(readFileSync(pendingPath(), "utf8")) as Convention[];
  } catch {
    return [];
  }
}
function writePending(p: Convention[]): void {
  mkdirSync(fleetDir(), { recursive: true });
  writeFileSync(pendingPath(), JSON.stringify(p, null, 2));
}
export function pendingConventions(): Convention[] {
  return readPending();
}

/** Run induction over every promotable candidate → stage proposals to the review queue (NOT live).
 *  Returns what was newly proposed. */
export async function runInduction(opts: InductorOptions & { threshold?: number; inductor?: Inductor } = {}): Promise<Convention[]> {
  const inductor = opts.inductor ?? llmInductor(opts);
  const pending = readPending();
  const have = new Set([...pending.map((p) => p.id), ...pending.map((p) => p.addresses)]);
  const proposed: Convention[] = [];
  for (const c of promotable(opts.threshold)) {
    if (have.has(c.signal)) continue; // already proposed for this signal
    const conv = await inductor(c);
    if (conv) {
      pending.push(conv);
      proposed.push(conv);
      have.add(conv.id);
      have.add(conv.addresses);
    }
  }
  writePending(pending);
  return proposed;
}

/** Operator approves a pending convention → it goes LIVE (into the store) AND drops a regression
 *  fixture so the harness locks it (a later convention that breaks this failure-class is caught). */
export function approveConvention(id: string): Convention | null {
  const pending = readPending();
  const conv = pending.find((c) => c.id === id);
  if (!conv) return null;
  addConvention(conv); // live — now injected into builds
  try {
    mkdirSync(fixturesDir(), { recursive: true });
    writeFileSync(join(fixturesDir(), `learned-${conv.id}.log`), `# regression fixture for learned convention '${conv.id}' (${conv.addresses})\n# auto-generated on approval; the harness asserts this failure class stays localizable.\n`);
  } catch {
    /* fixtures dir unavailable (e.g. prod) → skip the file; the convention is still live */
  }
  writePending(pending.filter((c) => c.id !== id));
  return conv;
}
