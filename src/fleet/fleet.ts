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

export type Phase = "planning" | "codegen" | "both";
export interface Convention {
  id: string;
  stack: string; // normalized scope, e.g. "next-supabase" — prevents a Python lesson poisoning a Next build
  phase?: Phase; // where it's injected — architect (planning), codegen, or both. Default: codegen.
  rule: string; // the abstract convention (never a user's code)
  addresses: string; // the gate/failure signal it prevents (e.g. "verify:build-failed")
  builds: number; // how many independent builds validated it
}
/** Evidence that a fix CLEARED a gate finding — the other half of an inducible lesson. */
export interface Resolution {
  message: string; // the localized finding that was resolved
  files: string[]; // the files whose change cleared it (the "fix that worked")
}
export interface Candidate {
  key: string;
  stack: string;
  signal: string; // a gate finding signature, e.g. "rls:rls-service-key-bypass"
  builds: number; // total occurrences
  apps: string[]; // DISTINCT apps it occurred in — diversity is the universal-vs-specific signal
  resolutions: Resolution[]; // verifier-gated evidence: fixes that made the gate go green
}

/** Seed learnings — validated by the gates over this development cycle. The store starts USEFUL,
 *  then grows by promotion. (These are abstract conventions; the hardcoded prompt holds the base
 *  set, the store holds what the fleet adds over time.) */
// SEEDED from this development cycle's validated (gate-failure → solution-that-passed) pairs —
// the bootstrap. Each was confirmed by a build clearing the gate after applying it; `builds` is
// how many independent ProCare variations validated it. (When the induction step lands, it grows
// this set automatically; until then this is the hand-curated head start.)
const SEED: Convention[] = [
  { id: "no-clerk", stack: "next-supabase", phase: "both", builds: 6, addresses: "rls + verify:build-failed (clerk)", rule: "Authentication MUST be Supabase Auth — never Clerk, Auth0, NextAuth/Auth.js, Firebase Auth, or custom auth. A third-party provider breaks the auth.uid() link RLS depends on and pulls in webhooks/SDKs (svix, clerk middleware) that fight the gates. Social logins (Google/GitHub/Apple/…) come free via supabase.auth.signInWithOAuth({ provider }) + an app/auth/callback route that calls exchangeCodeForSession." },
  { id: "next15-async-apis", stack: "next-supabase", phase: "codegen", builds: 5, addresses: "verify:build-failed (Property 'get' on Promise<ReadonlyHeaders>)", rule: "Next 15 async dynamic APIs MUST be awaited: `const c = await cookies(); c.get('x')` (NOT cookies().get). headers()/draftMode() too. A page/route's params and searchParams are Promises — type them Promise<...> and await. Calling .get/.has on an un-awaited headers()/cookies() is the #1 build break." },
  { id: "supabase-clients", stack: "next-supabase", phase: "codegen", builds: 4, addresses: "verify:build-failed (Module not found @/lib/supabase/* ; is not exported)", rule: "Create EXACTLY three Supabase client files and import them by these exact paths everywhere — no flat lib/supabase.ts, and every @/lib/supabase/* import must be a file you actually created: (1) lib/supabase/client.ts → export function createClient() using @supabase/ssr createBrowserClient (client components); (2) lib/supabase/server.ts → export async function createClient() using createServerClient + an async cookies adapter (request-scoped, RLS-enforced; the default for server code); (3) lib/supabase/admin.ts → ONE service-role accessor with ONE name, imported by that same name everywhere." },
  { id: "rls-service-key-admin-only", stack: "next-supabase", phase: "both", builds: 4, addresses: "rls:rls-service-key-bypass", rule: "The service-role client BYPASSES Row-Level Security — use it ONLY on clearly admin-only server paths (webhooks, background jobs, an admin dashboard gated on an admin role). For ANY normal user feature use the request-scoped createClient() so the database enforces per-user/per-tenant access via auth.uid(). Reaching user data with the service-role key is a blocking RLS finding." },
  { id: "server-actions", stack: "next-supabase", phase: "codegen", builds: 3, addresses: "verify:build-failed (does not match required types of a Next.js Page ; Promise<Result> not assignable to void)", rule: "A page.tsx/layout.tsx exports ONLY its default + Next's allowed members (metadata, generateMetadata, generateStaticParams, route config) — NEVER export a server action or other function from it (blocking 'does not match the required types of a Next.js Page'). Put actions in a separate actions.ts with a top-of-file \"use server\", or keep them as non-exported async functions (each with \"use server\" first line) used by that file's own forms. A fn passed to <form action={fn}> must be (formData: FormData) => Promise<void>; to return data use useActionState." },
  { id: "stripe-sdks", stack: "next-supabase", phase: "codegen", builds: 3, addresses: "verify:build-failed (apiVersion not assignable)", rule: "Integration SDKs (Stripe etc.): you don't know the SDK's current pinned API version, so OMIT a hardcoded apiVersion and let the installed SDK default — `new Stripe(process.env.STRIPE_SECRET_KEY!)`. Webhooks: read the RAW body with await req.text() and verify with stripe.webhooks.constructEventAsync(raw, sig, secret). Prefer library defaults over guessing post-cutoff version literals." },
  { id: "internal-api-consistency", stack: "next-supabase", phase: "codegen", builds: 3, addresses: "verify:build-failed (Expected N arguments ; is not exported)", rule: "A helper's DEFINITION and EVERY call site must agree on argument count and shape, and every imported name must actually be exported by its module. Decide each helper's signature once and use it consistently. Mismatched arity ('Expected 1 arguments, but got 3') and missing exports are blocking build errors." },
  { id: "postcss-boilerplate", stack: "next-supabase", phase: "codegen", builds: 3, addresses: "verify:build-failed (postcss plugins key)", rule: "Tailwind/PostCSS config is boilerplate: exactly one postcss.config.mjs exporting { plugins } — never duplicate it (two configs conflict) or hand-roll variants." },
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
export function fleetBlock(rawStack?: string, phase: Phase = "codegen"): string {
  const cs = loadConventions(normalizeStack(rawStack)).filter((c) => {
    const p = c.phase ?? "codegen";
    return p === phase || p === "both";
  });
  if (!cs.length) return "";
  return ["", "<learned_conventions>", "  Conventions VibeHard has LEARNED from prior builds (each cleared a gate, validated across builds). Follow them exactly:", ...cs.map((c, i) => `  ${i + 1}. ${c.rule}`), "</learned_conventions>"].join("\n");
}

/** Record a gate-failure signal from a build — the learning INPUT. Idempotent per build is the
 *  caller's job; here every call bumps the recurrence count. */
export function recordCandidate(rawStack: string | undefined, signal: string, appId?: string): void {
  const stack = normalizeStack(rawStack);
  const cands = read<Candidate[]>(candidatesPath(), []);
  const key = `${stack}::${signal}`;
  let c = cands.find((x) => x.key === key);
  if (!c) {
    c = { key, stack, signal, builds: 0, apps: [], resolutions: [] };
    cands.push(c);
  }
  c.builds += 1;
  if (appId && !c.apps.includes(appId)) c.apps.push(appId); // count DISTINCT apps (diversity)
  write(candidatesPath(), cands);
}

/** Attach the VERIFIER-GATED evidence that a fix cleared this finding (gate went block→pass).
 *  This is the keystone of induction — the (failure → solution) pair, not just "it failed". */
export function recordResolution(rawStack: string | undefined, signal: string, ev: Resolution): void {
  const stack = normalizeStack(rawStack);
  const cands = read<Candidate[]>(candidatesPath(), []);
  const key = `${stack}::${signal}`;
  let c = cands.find((x) => x.key === key);
  if (!c) {
    c = { key, stack, signal, builds: 1, apps: [], resolutions: [] };
    cands.push(c);
  }
  if (!c.resolutions) c.resolutions = [];
  if (c.resolutions.length < 5) c.resolutions.push({ message: ev.message.slice(0, 200), files: ev.files.slice(0, 8) });
  write(candidatesPath(), cands);
}

/** Candidates that recurred enough to deserve a convention — the promotion gate. (The next step
 *  is LLM-inducing the rule wording for these + a human/regression check; this surfaces them.) */
export function promotable(threshold = PROMOTION_THRESHOLD): Candidate[] {
  const have = new Set(loadConventions().map((c) => c.addresses));
  return read<Candidate[]>(candidatesPath(), []).filter((c) => {
    // DIVERSITY gate: when we tracked which apps it hit, require it recurred across that many
    // DISTINCT apps — a failure in one app retried N times is likely SPECIFIC, not universal.
    // (Falls back to raw occurrence count only when app identity wasn't recorded.)
    const diversity = c.apps && c.apps.length ? c.apps.length : c.builds;
    return diversity >= threshold && !have.has(c.signal);
  });
}

/** Commit a reviewed, verifier-validated convention into the store (LLM proposes, this disposes). */
export function addConvention(c: Omit<Convention, "builds"> & { builds?: number }): void {
  const all = loadConventions();
  if (all.some((x) => x.id === c.id)) return;
  all.push({ builds: 1, ...c });
  write(storePath(), all);
}
