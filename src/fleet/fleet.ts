/**
 * THE FLEET LEARNING storePath() — VibeHard's proprietary, cross-build, cross-user knowledge.
 *
 * It accumulates conventions LEARNED from builds (a gate failure that a fix cleared, recurring
 * across many builds) and injects them into codegen so every future job — for every user —
 * benefits. This is the moat: the platform compounds.
 *
 * ── PRIVATE PLATFORM ASSET — users NEVER receive or see a copy ──────────────────────────────
 * Users BENEFIT from it but cannot obtain it. It lives OUTSIDE any build workspace, is injected
 * ONLY into the codegen SYSTEM PROMPT (the recipe — not the delivered app), and is never written
 * into a generated app, a user artifact, the as-built journal, or any user-facing log. The store
 * holds ABSTRACT conventions, never a user's code or data. `fleet.leak.test.ts` enforces this.
 *
 * ── SAFETY: verifier-gated, not self-judgment ───────────────────────────────────────────────
 * A candidate becomes a convention only when the failure it addresses was cleared by a fix that
 * made a deterministic GATE go green, AND it recurred across ≥ PROMOTION_THRESHOLD builds. The
 * LLM proposes the wording; the gate + frequency dispose. (This is the difference between safe
 * fleet learning and the self-correction loops that drift/reward-hack — see PROCARE_HARDENING.)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Platform-private location — deliberately OUTSIDE any tenant/build directory. Read lazily so
 *  the path is always current (and tests can point it at a throwaway dir). */
const dir = (): string => process.env.VIBEHARD_FLEET_DIR ?? join(homedir(), ".vibehard", "fleet");
const storePath = (): string => join(dir(), "conventions.json");
const candidatesPath = (): string => join(dir(), "candidates.json");
export const PROMOTION_THRESHOLD = 3;

export interface Convention {
  id: string;
  stack: string; // normalized scope, e.g. "next-supabase" — prevents a Python lesson poisoning a Next build
  rule: string; // the abstract convention (never a user's code)
  addresses: string; // the gate/failure signal it prevents (e.g. "verify:build-failed")
  builds: number; // how many independent builds validated it
}
export interface Candidate {
  key: string;
  stack: string;
  signal: string; // a gate finding signature, e.g. "rls:rls-service-key-bypass"
  builds: number;
}

/** Seed learnings — validated by the gates over this development cycle. The store starts USEFUL,
 *  then grows by promotion. (These are abstract conventions; the hardcoded prompt holds the base
 *  set, the store holds what the fleet adds over time.) */
const SEED: Convention[] = [
  { id: "no-clerk", stack: "next-supabase", rule: "Use Supabase Auth, never Clerk/Auth0/NextAuth — a third-party auth provider breaks the auth.uid() link RLS depends on and pulls in webhooks/SDKs that fight the gates.", addresses: "rls + verify:build-failed", builds: 6 },
  { id: "postcss-boilerplate", stack: "next-supabase", rule: "Tailwind/PostCSS config is boilerplate: exactly one postcss.config.mjs exporting { plugins } — never duplicate it or hand-roll variants.", addresses: "verify:build-failed (postcss plugins key)", builds: 3 },
];

function read<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function write(path: string, data: unknown): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** Normalize a freeform architecture stack string to a scope key. */
export function normalizeStack(raw: string | undefined): string {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("fastapi") || s.includes("python")) return "python-fastapi";
  if (s.includes("supabase") || s.includes("next")) return "next-supabase";
  return "next-supabase"; // the dominant stack
}

export function loadConventions(stack?: string): Convention[] {
  let all = existsSync(storePath()) ? read<Convention[]>(storePath(), []) : (write(storePath(), SEED), SEED);
  if (stack) all = all.filter((c) => !c.stack || c.stack === stack);
  return all;
}

/** The block injected into codegen's SYSTEM prompt (the recipe). Empty when nothing applies.
 *  NEVER write this into a workspace or a user-facing artifact — system prompt only. */
export function fleetBlock(rawStack?: string): string {
  const cs = loadConventions(normalizeStack(rawStack));
  if (!cs.length) return "";
  return ["", "<learned_conventions>", "  Conventions VibeHard has LEARNED from prior builds (each cleared a gate and recurred). Follow them like the rules above:", ...cs.map((c) => `  - ${c.rule}`), "</learned_conventions>"].join("\n");
}

/** Record a gate-failure signal from a build — the learning INPUT. Idempotent per build is the
 *  caller's job; here every call bumps the recurrence count. */
export function recordCandidate(rawStack: string | undefined, signal: string): void {
  const stack = normalizeStack(rawStack);
  const cands = read<Candidate[]>(candidatesPath(), []);
  const key = `${stack}::${signal}`;
  const c = cands.find((x) => x.key === key);
  if (c) c.builds += 1;
  else cands.push({ key, stack, signal, builds: 1 });
  write(candidatesPath(), cands);
}

/** Candidates that recurred enough to deserve a convention — the promotion gate. (The next step
 *  is LLM-inducing the rule wording for these + a human/regression check; this surfaces them.) */
export function promotable(threshold = PROMOTION_THRESHOLD): Candidate[] {
  const have = new Set(loadConventions().map((c) => c.addresses));
  return read<Candidate[]>(candidatesPath(), []).filter((c) => c.builds >= threshold && !have.has(c.signal));
}

/** Commit a reviewed, verifier-validated convention into the store (LLM proposes, this disposes). */
export function addConvention(c: Omit<Convention, "builds"> & { builds?: number }): void {
  const all = loadConventions();
  if (all.some((x) => x.id === c.id)) return;
  all.push({ builds: 1, ...c });
  write(storePath(), all);
}
