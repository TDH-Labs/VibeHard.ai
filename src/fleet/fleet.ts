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
import { sanitizeUntrusted } from "./sanitize.ts";
import { httpFleetStore } from "./http-client.ts";
import { localFleetStore, PgFleetStore, ensureFleetSchema, FLEET_SEED, type Candidate, type Convention, type FleetStore, type Phase, type Resolution } from "./store.ts";
import { postgresSql } from "../platform/db.ts";

export type { Candidate, Convention, FleetStore, Phase, Resolution };
export const PROMOTION_THRESHOLD = 3;

/**
 * Which backing store this process actually uses, resolved once and cached (repeated calls
 * within one CLI invocation reuse the same connection instead of re-resolving/re-connecting):
 *
 *   1. A dispatch token (VIBEHARD_PLATFORM_BASE_URL/VIBEHARD_RECORD_TOKEN) — an E2B sandbox, no
 *      durable state of its own and no direct DB access by design. Goes through the platform's
 *      tokened HTTP endpoint.
 *   2. DATABASE_URL — a local (non-E2B) dispatch, which inherits the platform's full env and can
 *      reach Postgres directly; ALSO an operator running `vibehard fleet induct/approve` near the
 *      platform. Unlike escalation, this tier matters here even for local dispatch: fleet data is
 *      meant to accumulate across EVERY build, not just be durable enough for one build's own
 *      later read, so routing local dispatch through the same global table (rather than its own
 *      machine's disk) is strictly more correct, not just "good enough".
 *   3. Neither — pure local/dev use (no platform behind the CLI at all) keeps today's exact
 *      file-backed behavior, unchanged.
 */
let cached: Promise<FleetStore> | null = null;
export function resolveFleetStore(): Promise<FleetStore> {
  if (cached) return cached;
  cached = (async () => {
    const baseUrl = process.env.VIBEHARD_PLATFORM_BASE_URL;
    const token = process.env.VIBEHARD_RECORD_TOKEN;
    if (baseUrl && token) return httpFleetStore({ baseUrl, token });
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      const { sql } = postgresSql(dbUrl);
      await ensureFleetSchema(sql, FLEET_SEED);
      return new PgFleetStore(sql);
    }
    return localFleetStore(FLEET_SEED);
  })();
  return cached;
}
/** Test-only: forget the cached resolution so the next call re-reads env vars (e.g. a test that
 *  changes VIBEHARD_FLEET_DIR/DATABASE_URL between cases needs a fresh resolution, not the first
 *  test's cached store). Never called from production code. */
export function __resetFleetStoreForTests(): void {
  cached = null;
}

/** Normalize a freeform architecture stack string to a scope key. */
export function normalizeStack(raw: string | undefined): string {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("fastapi") || s.includes("python")) return "python-fastapi";
  if (s.includes("supabase") || s.includes("next")) return "next-supabase";
  return "next-supabase"; // the dominant stack
}

export async function loadConventions(stack?: string): Promise<Convention[]> {
  let all = await (await resolveFleetStore()).getConventions();
  if (stack) all = all.filter((c) => !c.stack || c.stack === stack);
  return all;
}

/** The block injected into codegen's SYSTEM prompt (the recipe). Empty when nothing applies.
 *  NEVER write this into a workspace or a user-facing artifact — system prompt only. */
export async function fleetBlock(rawStack?: string, phase: Phase = "codegen"): Promise<string> {
  const cs = (await loadConventions(normalizeStack(rawStack))).filter((c) => {
    const p = c.phase ?? "codegen";
    return p === phase || p === "both";
  });
  if (!cs.length) return "";
  // audit3 HIGH-2: scrub each rule again at render time. A convention is human-approved, but the rule
  // text traces back to untrusted build output — sanitizing here means an injection that slipped through
  // induction can't reach the codegen system prompt verbatim.
  return ["", "<learned_conventions>", "  Conventions VibeHard has LEARNED from prior builds (each cleared a gate, validated across builds). Follow them exactly:", ...cs.map((c, i) => `  ${i + 1}. ${sanitizeUntrusted(c.rule, 400)}`), "</learned_conventions>"].join("\n");
}

/** Record a gate-failure signal from a build — the learning INPUT. Idempotent per build is the
 *  caller's job; here every call bumps the recurrence count. */
export async function recordCandidate(rawStack: string | undefined, signal: string, appId?: string): Promise<void> {
  const store = await resolveFleetStore();
  const stack = normalizeStack(rawStack);
  const key = `${stack}::${signal}`;
  const c = (await store.getCandidate(key)) ?? { key, stack, signal, builds: 0, apps: [], resolutions: [] };
  c.builds += 1;
  if (!c.apps) c.apps = []; // legacy candidates (written before the diversity field) have none
  if (appId && !c.apps.includes(appId)) c.apps.push(appId); // count DISTINCT apps (diversity)
  await store.putCandidate(c);
}

/** Attach the VERIFIER-GATED evidence that a fix cleared this finding (gate went block→pass).
 *  This is the keystone of induction — the (failure → solution) pair, not just "it failed". */
export async function recordResolution(rawStack: string | undefined, signal: string, ev: Resolution): Promise<void> {
  const store = await resolveFleetStore();
  const stack = normalizeStack(rawStack);
  const key = `${stack}::${signal}`;
  const c = (await store.getCandidate(key)) ?? { key, stack, signal, builds: 1, apps: [], resolutions: [] };
  if (!c.resolutions) c.resolutions = [];
  if (c.resolutions.length < 5) c.resolutions.push({ message: ev.message.slice(0, 200), files: ev.files.slice(0, 8) });
  await store.putCandidate(c);
}

/** Candidates that recurred enough to deserve a convention — the promotion gate. (The next step
 *  is LLM-inducing the rule wording for these + a human/regression check; this surfaces them.) */
export async function promotable(threshold = PROMOTION_THRESHOLD): Promise<Candidate[]> {
  const store = await resolveFleetStore();
  const have = new Set((await loadConventions()).map((c) => c.addresses));
  return (await store.listCandidates()).filter((c) => {
    // DIVERSITY gate: when we tracked which apps it hit, require it recurred across that many
    // DISTINCT apps — a failure in one app retried N times is likely SPECIFIC, not universal.
    // (Falls back to raw occurrence count only when app identity wasn't recorded.)
    const diversity = c.apps && c.apps.length ? c.apps.length : c.builds;
    return diversity >= threshold && !have.has(c.signal);
  });
}

/** Commit a reviewed, verifier-validated convention into the store (LLM proposes, this disposes). */
export async function addConvention(c: Omit<Convention, "builds"> & { builds?: number }): Promise<void> {
  const store = await resolveFleetStore();
  const all = await loadConventions();
  if (all.some((x) => x.id === c.id)) return;
  await store.putConvention({ builds: 1, ...c });
}
