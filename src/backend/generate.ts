/**
 * Deterministic backend generator. Given a structured DataModel, write the migrations, RLS, auth,
 * and Supabase clients as REAL, OWNED files — the layer that, when LLM-authored, produced every
 * backend bug we've hit. By construction this eliminates: invalid multi-command `FOR` clauses (we
 * only emit `FOR ALL ... USING ... WITH CHECK`), forward foreign keys (topo order + deferred ALTER
 * for any back-edge), function/policy-before-table ordering (tables → helpers → policies, in
 * separate ordered files), and RLS recursion (helpers are SECURITY DEFINER, so a policy that calls
 * them never re-enters the table's own RLS). It also writes the auth route + first-account bootstrap
 * that were missing on ProCare.
 *
 * GENERATE-THEN-OWN: each file carries a `@vibehard:generated` marker. On re-run we overwrite files
 * that still carry it; a file the user/SWE has taken ownership of (marker removed, or hand-written)
 * is left untouched. Never a roach motel — the migrate/rls gates remain the safety net for edits.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { DataModel, Entity, Field } from "./model.ts";

const MARKER = "@vibehard:generated";
const OWNED_MANIFEST = ".vibehard/owned.json";

const hashOf = (s: string): string => createHash("sha256").update(s).digest("hex");

type OwnedManifest = Record<string, string>; // relPath → sha256 of the LAST content we generated

function loadManifest(target: string): OwnedManifest {
  try {
    return JSON.parse(readFileSync(join(target, OWNED_MANIFEST), "utf8")) as OwnedManifest;
  } catch {
    return {};
  }
}

/**
 * Ownership tracked OUT OF BAND (audit CRITICAL): we own a file only while it still hashes to what we
 * last generated — never inferred from a comment in the body (which the user keeps when they edit, and
 * a formatter strips). So:
 *   • new file, or unchanged-since-we-generated-it → (over)write + record the new hash;
 *   • the user EDITED our file (hash diverged) → DON'T clobber; write `<file>.vibehard-new` + warn;
 *   • a pre-existing foreign file we never generated → preserve + warn;
 *   • backward-compat: a marker-bearing file with no manifest entry is a pre-manifest generation → adopt.
 * Returns whether the canonical file was (over)written.
 */
function writeManaged(target: string, rel: string, content: string, manifest: OwnedManifest, warnings: string[]): boolean {
  const abs = join(target, rel);
  const newHash = hashOf(content);
  if (existsSync(abs)) {
    let current = "";
    try {
      current = readFileSync(abs, "utf8");
    } catch {
      return false;
    }
    if (hashOf(current) === newHash) {
      manifest[rel] = newHash;
      return true; // already exactly this — idempotent
    }
    const last = manifest[rel];
    if (last === undefined) {
      // never recorded. If it carries the legacy marker it's a pre-manifest generation we may adopt;
      // otherwise it's the user's own file → never clobber.
      if (!current.includes(MARKER)) {
        warnings.push(`preserved ${rel} — a pre-existing file VibeHard didn't generate; not overwriting.`);
        return false;
      }
    } else if (hashOf(current) !== last) {
      // we generated it, then the USER changed it → keep their edits, surface the regenerated version.
      writeFileSync(`${abs}.vibehard-new`, content);
      warnings.push(`kept your edits to ${rel}; wrote the regenerated version to ${rel}.vibehard-new for review. (VibeHard won't overwrite ${rel} until it matches a generated version again.)`);
      return false;
    }
    // last === current hash → unchanged since we generated it → safe to overwrite.
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  manifest[rel] = newHash;
  return true;
}

const q = (s: string): string => `"${s}"`;
/** A SQL string LITERAL (value position), single-quotes escaped. Defense-in-depth for model values
 *  like adminRole that are interpolated into emitted SQL — the coercer also restricts their charset. */
const lit = (s: string): string => `'${String(s).replace(/'/g, "''")}'`;

function columnSql(f: Field): string {
  const parts = [q(f.name), f.type];
  if (!f.nullable) parts.push("not null");
  if (f.default) parts.push(`default ${f.default}`);
  if (f.unique) parts.push("unique");
  return "  " + parts.join(" ");
}

/** Order entities so an entity is emitted after the entities it references. Back-edges (cycles) are
 *  returned separately so their FKs can be added by a deferred ALTER — making forward refs impossible. */
function topoOrder(entities: Entity[]): { ordered: Entity[]; deferred: Array<{ from: string; field: Field }> } {
  const byName = new Map(entities.map((e) => [e.name, e]));
  const ordered: Entity[] = [];
  const done = new Set<string>();
  const deferred: Array<{ from: string; field: Field }> = [];
  const remaining = new Set(entities.map((e) => e.name));
  while (remaining.size) {
    // an entity is ready if every FK target is already emitted (or is itself / not a real entity)
    const ready = [...remaining].filter((n) =>
      byName.get(n)!.fields.every((f) => !f.references || done.has(f.references) || f.references === n || !byName.has(f.references)),
    );
    if (ready.length === 0) {
      // a cycle: take one, emit it WITHOUT its not-yet-ready FKs (those become deferred ALTERs)
      const n = [...remaining][0]!;
      const e = byName.get(n)!;
      for (const f of e.fields) if (f.references && !done.has(f.references) && f.references !== n && byName.has(f.references)) deferred.push({ from: n, field: f });
      ordered.push({ ...e, fields: e.fields.filter((f) => !deferred.some((d) => d.from === n && d.field.name === f.name)) });
      done.add(n);
      remaining.delete(n);
      continue;
    }
    for (const n of ready) {
      ordered.push(byName.get(n)!);
      done.add(n);
      remaining.delete(n);
    }
  }
  return { ordered, deferred };
}

function fkClause(f: Field): string {
  return f.references ? `  ${q(f.name)} uuid${f.nullable ? "" : " not null"} references ${q(f.references)}(${q("id")}) on delete cascade` : columnSql(f);
}

/** Columns the generator synthesizes for EVERY table — a model field of the same name collides with
 *  them. Real LLM data models almost always list an explicit `id`, which duplicates our primary key
 *  ("column id specified more than once" on apply); `createdAt` is ours too. Compared case-folded. */
const RESERVED_COLUMNS = new Set(["id", "createdat"]);

/** Drop model fields that would collide with a generator-owned column, and any duplicate field names
 *  (the LLM occasionally repeats one). Run before everything else so the migrations, RLS, seed, and
 *  dashboard all see one clean, conflict-free model. */
function normalizeFields(model: DataModel): DataModel {
  const entities = model.entities.map((e) => {
    const seen = new Set<string>();
    const fields = e.fields.filter((f) => {
      const k = f.name.toLowerCase();
      if (RESERVED_COLUMNS.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { ...e, fields };
  });
  return { ...model, entities };
}

/** Ensure the membership entity carries the columns the RLS helpers + bootstrap rely on. */
function withMembershipColumns(model: DataModel): DataModel {
  if (!model.membershipEntity) return model;
  const entities = model.entities.map((e) => {
    if (e.name !== model.membershipEntity) return e;
    const have = new Set(e.fields.map((f) => f.name));
    const add: Field[] = [];
    if (!have.has("authUserId")) add.push({ name: "authUserId", type: "uuid", nullable: false, unique: true, default: undefined, references: undefined });
    if (!have.has(model.tenantField) && model.tenantEntity) add.push({ name: model.tenantField, type: "uuid", nullable: false, references: model.tenantEntity });
    if (!have.has(model.roleField)) add.push({ name: model.roleField, type: "text", nullable: false, default: lit(model.adminRole) });
    return { ...e, fields: [...add, ...e.fields] };
  });
  return { ...model, entities };
}

function migrationInit(model: DataModel): string {
  const { ordered, deferred } = topoOrder(model.entities);
  const lines = [`-- ${MARKER} — schema (tables only; RLS in a later migration). Edit freely; the marker hands ownership back to you (we stop regenerating this file).`, ""];
  for (const e of ordered) {
    const cols = [`  ${q("id")} uuid primary key default gen_random_uuid()`, ...e.fields.map(fkClause), `  ${q("createdAt")} timestamptz not null default now()`];
    lines.push(`create table if not exists ${q(e.name)} (`, cols.join(",\n"), ");", "");
  }
  for (const d of deferred) {
    lines.push(`-- deferred FK (back-edge) to avoid a forward reference`, `alter table ${q(d.from)} add column if not exists ${q(d.field.name)} uuid references ${q(d.field.references!)}(${q("id")}) on delete cascade;`, "");
  }
  return lines.join("\n");
}

/** A safe literal to fill a required tenant-root column when the bootstrap auto-creates a new tenant. */
function bootstrapLiteral(f: Field): string {
  if (f.references) return "gen_random_uuid()"; // a required FK on the tenant root is unusual; best effort
  switch (f.type) {
    case "text": return "'New workspace'";
    case "text[]": return "'{}'::text[]";
    case "integer": return "0";
    case "numeric": return "0";
    case "boolean": return "false";
    case "timestamptz": return "now()";
    case "date": return "current_date";
    case "jsonb": return "'{}'::jsonb";
    case "uuid": return "gen_random_uuid()";
    default: return "''";
  }
}

/** INSERT that creates a fresh tenant (filling its required columns) and returns its id into
 *  `assigned_tenant` — used by the bootstrap for a self-service signup that owns its own new tenant. */
function newTenantInsert(model: DataModel): string {
  const te = model.entities.find((e) => e.name === model.tenantEntity);
  const req = (te?.fields ?? []).filter((f) => !f.nullable && !f.default);
  const cols = req.map((f) => q(f.name));
  const vals = req.map((f) => bootstrapLiteral(f));
  const body = cols.length ? `(${cols.join(", ")}) values (${vals.join(", ")})` : "default values";
  return `insert into ${q(model.tenantEntity!)} ${body} returning ${q("id")} into assigned_tenant;`;
}

function migrationAuthHelpers(model: DataModel): string {
  if (!model.membershipEntity) return "";
  const m = q(model.membershipEntity);
  const tf = q(model.tenantField);
  const rf = q(model.roleField);
  const hasEmail = model.entities.find((e) => e.name === model.membershipEntity)?.fields.some((f) => f.name === "email");
  const hasName = model.entities.find((e) => e.name === model.membershipEntity)?.fields.some((f) => f.name === "name");
  // Membership row written by the bootstrap. tenant + role are SERVER-assigned (assigned_*), never read
  // from client-set raw_user_meta_data (the takeover vector). Display name is non-privileged → fine.
  const memCols = ["authUserId", ...(model.tenantEntity ? [model.tenantField] : []), model.roleField, ...(hasEmail ? ["email"] : []), ...(hasName ? ["name"] : [])];
  const memVals = ["new.id", ...(model.tenantEntity ? ["assigned_tenant"] : []), "assigned_role", ...(hasEmail ? ["new.email"] : []), ...(hasName ? ["new.raw_user_meta_data->>'name'"] : [])];
  const declares = `declare assigned_role text${model.tenantEntity ? "; assigned_tenant uuid" : ""};`;
  const tenantBootstrap = model.tenantEntity
    ? [
        `  assigned_tenant := nullif(new.raw_app_meta_data->>'tenantId','')::uuid;`,
        `  if assigned_tenant is null then`,
        `    -- self-service signup → a fresh OWN tenant; the creator is its admin (no access to anyone else's data).`,
        `    ${newTenantInsert(model)}`,
        `    assigned_role := ${lit(model.adminRole)};`,
        `  end if;`,
      ]
    : [];
  const trigger = [
    `-- Bootstrap (SECURITY-CRITICAL): tenant + role come ONLY from raw_app_meta_data, which the service`,
    `-- role sets server-side (e.g. a validated invite-accept). raw_user_meta_data is set by the CLIENT at`,
    `-- signUp, so it is NEVER trusted for tenant/role — trusting it let any signup self-assign admin of any tenant.`,
    `create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public, auth as $$`,
    declares,
    `begin`,
    `  assigned_role := coalesce(nullif(new.raw_app_meta_data->>'role',''), ${lit(model.adminRole)});`,
    ...tenantBootstrap,
    `  insert into ${m} (${memCols.map(q).join(", ")}) values (${memVals.join(", ")});`,
    `  return new;`,
    `end $$;`,
    `drop trigger if exists on_auth_user_created on auth.users;`,
    `create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();`,
    "",
  ].join("\n");
  return [
    `-- ${MARKER} — auth helpers + first-account bootstrap. SECURITY DEFINER so policies that call`,
    `-- these never re-enter the membership table's own RLS (avoids "stack depth exceeded" recursion).`,
    "",
    `create or replace function auth_tenant_id() returns uuid language sql stable security definer set search_path = public as $$`,
    `  select ${tf} from ${m} where ${q("authUserId")} = auth.uid() limit 1`,
    `$$;`,
    "",
    `-- the caller's membership-row id — lets a table owned INDIRECTLY (a user_id FK) scope by ownership`,
    `-- without carrying authUserId itself, and without re-entering the membership table's RLS.`,
    `create or replace function auth_member_id() returns uuid language sql stable security definer set search_path = public as $$`,
    `  select ${q("id")} from ${m} where ${q("authUserId")} = auth.uid() limit 1`,
    `$$;`,
    "",
    `create or replace function auth_is_member() returns boolean language sql stable security definer set search_path = public as $$`,
    `  select exists (select 1 from ${m} where ${q("authUserId")} = auth.uid())`,
    `$$;`,
    "",
    `create or replace function auth_is_admin() returns boolean language sql stable security definer set search_path = public as $$`,
    `  select exists (select 1 from ${m} where ${q("authUserId")} = auth.uid() and ${rf} = ${lit(model.adminRole)})`,
    `$$;`,
    "",
    trigger,
  ].join("\n");
}

/** The SQL boolean for "this row belongs to the current user", from how the entity links to the
 *  membership table — so an owner policy NEVER references a column the table doesn't have (the live
 *  bug: `bookings`/`payments` are owner-scoped via a `user_id` FK, not their own `authUserId`).
 *  Returns null when no ownership link exists → the caller falls back to a safe scope. */
function ownerPredicate(e: Entity, model: DataModel): string | null {
  const has = (name: string) => e.fields.some((f) => f.name === name);
  // The membership table itself, or any table that carries authUserId → owned directly.
  if (e.name === model.membershipEntity || has("authUserId")) return `${q("authUserId")} = auth.uid()`;
  if (!model.membershipEntity) return null;
  // Otherwise owned INDIRECTLY: an explicit ownerField, else a FK to the membership table.
  const link = (e.ownerField && has(e.ownerField) ? e.ownerField : null) ?? e.fields.find((f) => f.references === model.membershipEntity)?.name ?? null;
  return link ? `${q(link)} = auth_member_id()` : null;
}

/** The RLS policy block for one entity, from its declared access. Only `FOR ALL ... USING ... WITH
 *  CHECK` and `FOR SELECT ... USING` are emitted — never the invalid multi-command FOR clause. */
function policiesFor(e: Entity, model: DataModel, warnings: string[]): string[] {
  const t = q(e.name);
  const out = [`alter table ${t} enable row level security;`];
  const tf = q(e.tenantField ?? model.tenantField);
  const hasTenantCol = e.fields.some((f) => f.name === (e.tenantField ?? model.tenantField));
  const tenantScoped = !!model.membershipEntity; // a multi-tenant model (has a membership table)

  // FAIL CLOSED: a multi-tenant table we cannot scope gets DENY-ALL, never authenticated-only (which
  // would expose every tenant's rows — the C2/C3 fail-open). The dev sees a warning and fixes the model.
  const deny = (why: string): string[] => {
    warnings.push(`RLS "${e.name}" (access "${e.access}"): ${why} → emitting a DENY-ALL policy (fail closed). Mark it "auth"/"public" if it is genuinely shared, or add ${e.access === "owner" ? "an owner link or the tenant column" : "the tenant column"}.`);
    return [`create policy ${q(e.name + "_deny")} on ${t} for all using (false) with check (false);`];
  };
  // Single-tenant model (no membership table): there is exactly ONE tenant, so authenticated-shared is
  // the intended scope and is NOT a cross-tenant leak. Only reachable when tenantScoped is false.
  const authShared = (readOnly = false): string[] =>
    readOnly
      ? [`create policy ${q(e.name + "_auth_read")} on ${t} for select using (auth.uid() is not null);`]
      : [`create policy ${q(e.name + "_auth_all")} on ${t} for all using (auth.uid() is not null) with check (auth.uid() is not null);`];

  if (e.name === model.tenantEntity) {
    // the tenant root: a member sees their own tenant; an admin manages it.
    out.push(`create policy ${q(e.name + "_member_read")} on ${t} for select using (${q("id")} = auth_tenant_id());`);
    out.push(`create policy ${q(e.name + "_admin_all")} on ${t} for all using (${q("id")} = auth_tenant_id() and auth_is_admin()) with check (${q("id")} = auth_tenant_id() and auth_is_admin());`);
    return out;
  }
  switch (e.access) {
    case "owner": {
      const pred = ownerPredicate(e, model);
      if (pred) {
        out.push(`create policy ${q(e.name + "_owner_all")} on ${t} for all using (${pred}) with check (${pred});`);
        // A tenant admin manages EVERYONE's rows in their tenant — but only when the row carries the
        // tenant column, so the admin stays scoped to their own tenant. Permissive ⇒ Postgres ORs it.
        if (tenantScoped && hasTenantCol) out.push(`create policy ${q(e.name + "_admin_all")} on ${t} for all using (${tf} = auth_tenant_id() and auth_is_admin()) with check (${tf} = auth_tenant_id() and auth_is_admin());`);
        break;
      }
      if (tenantScoped && hasTenantCol) out.push(`create policy ${q(e.name + "_tenant_all")} on ${t} for all using (${tf} = auth_tenant_id()) with check (${tf} = auth_tenant_id());`);
      else if (tenantScoped) out.push(...deny("owner-scoped but no owner link and no tenant column"));
      else out.push(...authShared());
      break;
    }
    case "tenant":
      if (tenantScoped && hasTenantCol) out.push(`create policy ${q(e.name + "_tenant_all")} on ${t} for all using (${tf} = auth_tenant_id()) with check (${tf} = auth_tenant_id());`);
      else if (tenantScoped) out.push(...deny("tenant-scoped but the table has no tenant column"));
      else out.push(...authShared());
      break;
    case "tenant-admin":
      if (tenantScoped && hasTenantCol) {
        out.push(`create policy ${q(e.name + "_tenant_read")} on ${t} for select using (${tf} = auth_tenant_id());`);
        out.push(`create policy ${q(e.name + "_admin_write")} on ${t} for all using (${tf} = auth_tenant_id() and auth_is_admin()) with check (${tf} = auth_tenant_id() and auth_is_admin());`);
      } else if (tenantScoped) out.push(...deny("tenant-admin but the table has no tenant column"));
      else out.push(...authShared(true));
      break;
    case "auth":
      out.push(...authShared(true)); // explicitly-declared shared reference data (any authenticated user)
      break;
    case "public":
      out.push(`create policy ${q(e.name + "_public_read")} on ${t} for select using (true);`);
      break;
  }
  return out;
}

function migrationRls(model: DataModel, warnings: string[]): string {
  const lines = [`-- ${MARKER} — Row-Level Security. Every table is protected; an unscopable table is DENIED,`, `-- never world-readable. Helpers live in the auth migration (SECURITY DEFINER, no recursion).`, ""];
  for (const e of model.entities) lines.push(...policiesFor(e, model, warnings), "");
  return lines.join("\n");
}

// ── Supabase client trio + auth route + middleware (the supabase-clients fleet convention, as code) ──

const CLIENT_BROWSER = `// ${MARKER}
import { createBrowserClient } from '@supabase/ssr';
export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
`;

const CLIENT_SERVER = `// ${MARKER}
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options as Parameters<typeof cookieStore.set>[2])),
    },
  });
}
`;

const CLIENT_ADMIN = `// ${MARKER}
// Service-role client — BYPASSES Row-Level Security. Use ONLY on admin-only server paths with no
// user session (webhooks, background jobs). Never import this for a normal user feature.
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase admin env (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) is not set.');
  return createSupabaseClient(url, key, { auth: { persistSession: false } });
}
`;

const SIGNIN_ROUTE = `// ${MARKER}
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const origin = req.nextUrl.origin;
  if (!email || !password) return NextResponse.redirect(new URL('/login?error=Enter%20your%20email%20and%20password.', origin), { status: 303 });
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return NextResponse.redirect(new URL(\`/login?error=\${encodeURIComponent(error.message)}\`, origin), { status: 303 });
  const to = req.nextUrl.searchParams.get('redirect');
  return NextResponse.redirect(new URL(to && to.startsWith('/') ? to : '/dashboard', origin), { status: 303 });
}
`;

const MIDDLEWARE = `// ${MARKER}
import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
const PUBLIC = ['/login', '/auth/callback', '/api/auth'];
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + '/'))) return NextResponse.next();
  const res = NextResponse.next();
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: { getAll: () => req.cookies.getAll(), setAll: (s) => s.forEach((c) => res.cookies.set(c.name, c.value, c.options as Parameters<typeof res.cookies.set>[2])) },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { const url = req.nextUrl.clone(); url.pathname = '/login'; url.searchParams.set('redirect', pathname); return NextResponse.redirect(url); }
  return res;
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api|.*\\\\..*).*)'] };
`;

export interface GenerateResult {
  written: string[];
  skipped: string[]; // user-owned files left untouched
  /** Security-relevant model gaps surfaced during generation (e.g. a table denied because it couldn't
   *  be safely scoped). Loud, not silent — the caller surfaces these / turns them into gate findings. */
  warnings: string[];
}

/** Generate the backend from the model into `target`. Idempotent + generate-then-own. */
export function generateBackend(target: string, rawModel: DataModel): GenerateResult {
  const model = withMembershipColumns(normalizeFields(rawModel));
  const warnings: string[] = [];
  const files: Array<{ rel: string; content: string }> = [
    { rel: "supabase/migrations/0001_init.sql", content: migrationInit(model) },
  ];
  const auth = migrationAuthHelpers(model);
  if (auth) files.push({ rel: "supabase/migrations/0002_auth.sql", content: auth });
  files.push({ rel: "supabase/migrations/0003_rls.sql", content: migrationRls(model, warnings) });
  files.push(
    { rel: "lib/supabase/client.ts", content: CLIENT_BROWSER },
    { rel: "lib/supabase/server.ts", content: CLIENT_SERVER },
    { rel: "lib/supabase/admin.ts", content: CLIENT_ADMIN },
    { rel: "app/api/auth/signin/route.ts", content: SIGNIN_ROUTE },
    { rel: "middleware.ts", content: MIDDLEWARE },
  );
  const manifest = loadManifest(target);
  const written: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    if (writeManaged(target, f.rel, f.content, manifest, warnings)) written.push(f.rel);
    else skipped.push(f.rel);
  }
  // Persist the coerced model (RLS-enforcement gate seeds from it) + the ownership manifest. Always
  // overwritten — internal artifacts, not user-owned.
  mkdirSync(join(target, ".vibehard"), { recursive: true });
  writeFileSync(join(target, ".vibehard", "datamodel.json"), JSON.stringify(rawModel, null, 2));
  writeFileSync(join(target, OWNED_MANIFEST), JSON.stringify(manifest, null, 2));
  return { written, skipped, warnings };
}
