/**
 * FleetStore — the durable backing for fleet learning (fleet.ts), replacing the bare
 * homedir()-rooted JSON files that never survive an E2B sandbox's teardown.
 *
 * THE BUG THIS CLOSES (found live 2026-07-20, sandbox-durability audit): fleet.ts's conventions
 * and candidates lived at `~/.vibehard/fleet/*.json` on WHATEVER machine was running the CLI. For
 * an E2B-dispatched build — every production build — that machine is a fresh, ephemeral sandbox:
 * `loadConventions()`/`fleetBlock()` (read, at codegen/architecture time) always saw an empty
 * store, and `recordCandidate()`/`recordResolution()` (write, during the auto-fix loop) wrote to a
 * disk that was destroyed the moment the sandbox tore down. The promotion mechanism (3 recurrences
 * across independent builds → a real convention) could never count past 1, silently, for the
 * entire time E2B dispatch has been live — the file's own header calls this "the moat"; it has
 * never once actually compounded in production.
 *
 * Unlike the record/secrets/escalation fixes, fleet data is NOT tenant- or app-scoped — it is
 * deliberately global, platform-wide, cross-tenant (see fleet.ts's header). So: no per-app auth
 * scoping on the HTTP endpoint (any valid dispatch token is sufficient — it just proves this is a
 * real, active build, not a specific app's own data); and unlike escalation, a LOCAL (non-E2B)
 * dispatch ALSO prefers the durable Postgres store over its own machine's disk whenever
 * DATABASE_URL is reachable (inherited from the platform's full env) — because the whole point of
 * fleet data is maximum accumulation across every build, local or sandboxed alike, not just
 * "durable enough for this one build's own later read" like escalation tickets.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Sql } from "../platform/pg-store.ts";

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
 *  set, the store holds what the fleet adds over time.) Lives here (not fleet.ts) so db.ts can
 *  seed the Postgres-backed table at boot without an import cycle through fleet.ts.
 *
 * SEEDED from this development cycle's validated (gate-failure → solution-that-passed) pairs —
 * the bootstrap. Each was confirmed by a build clearing the gate after applying it; `builds` is
 * how many independent ProCare variations validated it. (When the induction step lands, it grows
 * this set automatically; until then this is the hand-curated head start.) */
export const FLEET_SEED: Convention[] = [
  { id: "no-clerk", stack: "next-supabase", phase: "both", builds: 6, addresses: "rls + verify:build-failed (clerk)", rule: "Authentication MUST be Supabase Auth — never Clerk, Auth0, NextAuth/Auth.js, Firebase Auth, or custom auth. A third-party provider breaks the auth.uid() link RLS depends on and pulls in webhooks/SDKs (svix, clerk middleware) that fight the gates. Social logins (Google/GitHub/Apple/…) come free via supabase.auth.signInWithOAuth({ provider }) + an app/auth/callback route that calls exchangeCodeForSession." },
  { id: "next15-async-apis", stack: "next-supabase", phase: "codegen", builds: 5, addresses: "verify:build-failed (Property 'get' on Promise<ReadonlyHeaders>)", rule: "Next 15 async dynamic APIs MUST be awaited: `const c = await cookies(); c.get('x')` (NOT cookies().get). headers()/draftMode() too. A page/route's params and searchParams are Promises — type them Promise<...> and await. Calling .get/.has on an un-awaited headers()/cookies() is the #1 build break." },
  { id: "supabase-clients", stack: "next-supabase", phase: "codegen", builds: 4, addresses: "verify:build-failed (Module not found @/lib/supabase/* ; is not exported)", rule: "Create EXACTLY three Supabase client files and import them by these exact paths everywhere — no flat lib/supabase.ts, and every @/lib/supabase/* import must be a file you actually created: (1) lib/supabase/client.ts → export function createClient() using @supabase/ssr createBrowserClient (client components); (2) lib/supabase/server.ts → export async function createClient() using createServerClient + an async cookies adapter (request-scoped, RLS-enforced; the default for server code); (3) lib/supabase/admin.ts → ONE service-role accessor with ONE name, imported by that same name everywhere." },
  { id: "rls-service-key-admin-only", stack: "next-supabase", phase: "both", builds: 4, addresses: "rls:rls-service-key-bypass", rule: "The service-role client BYPASSES Row-Level Security — use it ONLY on clearly admin-only server paths (webhooks, background jobs, an admin dashboard gated on an admin role). For ANY normal user feature use the request-scoped createClient() so the database enforces per-user/per-tenant access via auth.uid(). Reaching user data with the service-role key is a blocking RLS finding." },
  { id: "server-actions", stack: "next-supabase", phase: "codegen", builds: 3, addresses: "verify:build-failed (does not match required types of a Next.js Page ; Promise<Result> not assignable to void)", rule: "A page.tsx/layout.tsx exports ONLY its default + Next's allowed members (metadata, generateMetadata, generateStaticParams, route config) — NEVER export a server action or other function from it (blocking 'does not match the required types of a Next.js Page'). Put actions in a separate actions.ts with a top-of-file \"use server\", or keep them as non-exported async functions (each with \"use server\" first line) used by that file's own forms. A fn passed to <form action={fn}> must be (formData: FormData) => Promise<void>; to return data use useActionState." },
  { id: "stripe-sdks", stack: "next-supabase", phase: "codegen", builds: 3, addresses: "verify:build-failed (apiVersion not assignable)", rule: "Integration SDKs (Stripe etc.): you don't know the SDK's current pinned API version, so OMIT a hardcoded apiVersion and let the installed SDK default — `new Stripe(process.env.STRIPE_SECRET_KEY!)`. Webhooks: read the RAW body with await req.text() and verify with stripe.webhooks.constructEventAsync(raw, sig, secret). Prefer library defaults over guessing post-cutoff version literals." },
  { id: "internal-api-consistency", stack: "next-supabase", phase: "codegen", builds: 3, addresses: "verify:build-failed (Expected N arguments ; is not exported)", rule: "A helper's DEFINITION and EVERY call site must agree on argument count and shape, and every imported name must actually be exported by its module. Decide each helper's signature once and use it consistently. Mismatched arity ('Expected 1 arguments, but got 3') and missing exports are blocking build errors." },
  { id: "postcss-boilerplate", stack: "next-supabase", phase: "codegen", builds: 3, addresses: "verify:build-failed (postcss plugins key)", rule: "Tailwind/PostCSS config is boilerplate: exactly one postcss.config.mjs exporting { plugins } — never duplicate it (two configs conflict) or hand-roll variants." },
  { id: "next-cache-vs-server-imports", stack: "next-supabase", phase: "codegen", builds: 1, addresses: "fast-precheck:typecheck (Module '\"next/server\"' has no exported member 'revalidatePath')", rule: "Next.js's module boundaries are NOT interchangeable: revalidatePath/revalidateTag/unstable_cache live in `next/cache`; redirect/notFound/permanentRedirect live in `next/navigation`; NextRequest/NextResponse/NextFetchEvent live in `next/server`. Importing any of these from the wrong module is a blocking typecheck error — verify each import's source module rather than guessing by association." },
  { id: "supabase-join-returns-array", stack: "next-supabase", phase: "codegen", builds: 1, addresses: "fast-precheck:typecheck (Conversion of type ... to type ... may be a mistake because neither type sufficiently overlaps)", rule: "A Supabase `.select('*, related(cols)')` on a to-one foreign key still types `related` as an ARRAY — Postgrest can't tell to-one from to-many from the query alone. Type it `related: { col: T }[]` and read `row.related[0]?.col`; never cast the raw query result straight to a hand-written interface that models the relation as a single object (a blocking typecheck error — 'neither type sufficiently overlaps with the other')." },
];

export interface FleetStore {
  getConventions(): Promise<Convention[]>;
  /** Operator-only (fleet.ts's addConvention, called from `vibehard fleet approve`) — never
   *  called from a sandboxed build. */
  putConvention(c: Convention): Promise<void>;
  getCandidate(key: string): Promise<Candidate | null>;
  putCandidate(c: Candidate): Promise<void>;
  /** Operator-only (fleet.ts's promotable, called from `vibehard fleet induct`) — never called
   *  from a sandboxed build. */
  listCandidates(): Promise<Candidate[]>;
}

/** Create the platform-wide (not tenant-scoped) fleet tables, seeding conventions from `seed` iff
 *  the table is empty. Idempotent — safe to call on every boot, same as the platform's other
 *  ensure*Schema functions. */
export async function ensureFleetSchema(sql: Sql, seed: Convention[]): Promise<void> {
  await sql(`create table if not exists fleet_conventions (id text primary key, data text not null)`);
  await sql(`create table if not exists fleet_candidates (key text primary key, data text not null)`);
  const rows = await sql(`select count(*)::int as count from fleet_conventions`);
  if (Number(rows[0]?.count ?? 0) === 0) {
    for (const c of seed) {
      await sql(`insert into fleet_conventions (id, data) values ($1, $2) on conflict (id) do nothing`, [c.id, JSON.stringify(c)]);
    }
  }
}

/** Postgres-backed FleetStore — global (no scope column; see header). */
export class PgFleetStore implements FleetStore {
  readonly name = "pg";
  constructor(private readonly sql: Sql) {}

  async getConventions(): Promise<Convention[]> {
    const rows = await this.sql(`select data from fleet_conventions`);
    return rows.map((r) => JSON.parse(String(r.data)) as Convention);
  }
  async putConvention(c: Convention): Promise<void> {
    await this.sql(`insert into fleet_conventions (id, data) values ($1, $2) on conflict (id) do update set data = excluded.data`, [c.id, JSON.stringify(c)]);
  }
  async getCandidate(key: string): Promise<Candidate | null> {
    const rows = await this.sql(`select data from fleet_candidates where key = $1`, [key]);
    return rows[0] ? (JSON.parse(String(rows[0].data)) as Candidate) : null;
  }
  async putCandidate(c: Candidate): Promise<void> {
    await this.sql(`insert into fleet_candidates (key, data) values ($1, $2) on conflict (key) do update set data = excluded.data`, [c.key, JSON.stringify(c)]);
  }
  async listCandidates(): Promise<Candidate[]> {
    const rows = await this.sql(`select data from fleet_candidates`);
    return rows.map((r) => JSON.parse(String(r.data)) as Candidate);
  }
}

/** File-backed FleetStore — today's exact pre-fix behavior, preserved verbatim for pure local/dev
 *  use (no platform behind the CLI at all: no dispatch token, no DATABASE_URL). Seeds `seed` on
 *  first read, same as the original loadConventions() did. */
export function localFleetStore(seed: Convention[]): FleetStore {
  const dir = (): string => process.env.VIBEHARD_FLEET_DIR ?? join(homedir(), ".vibehard", "fleet");
  const conventionsPath = (): string => join(dir(), "conventions.json");
  const candidatesPath = (): string => join(dir(), "candidates.json");
  function readJson<T>(path: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return fallback;
    }
  }
  function writeJson(path: string, data: unknown): void {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
  }
  return {
    async getConventions(): Promise<Convention[]> {
      if (!existsSync(conventionsPath())) {
        writeJson(conventionsPath(), seed);
        return seed;
      }
      return readJson<Convention[]>(conventionsPath(), seed);
    },
    async putConvention(c: Convention): Promise<void> {
      const all = await this.getConventions();
      if (all.some((x) => x.id === c.id)) return;
      writeJson(conventionsPath(), [...all, c]);
    },
    async getCandidate(key: string): Promise<Candidate | null> {
      const all = readJson<Candidate[]>(candidatesPath(), []);
      return all.find((x) => x.key === key) ?? null;
    },
    async putCandidate(c: Candidate): Promise<void> {
      const all = readJson<Candidate[]>(candidatesPath(), []);
      const i = all.findIndex((x) => x.key === c.key);
      if (i === -1) all.push(c);
      else all[i] = c;
      writeJson(candidatesPath(), all);
    },
    async listCandidates(): Promise<Candidate[]> {
      return readJson<Candidate[]>(candidatesPath(), []);
    },
  };
}
