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
import type { DataModel, Entity, Field } from "./model.ts";

const MARKER = "@vibehard:generated";

/** Write only if the path is unwritten or still VibeHard-owned (carries the marker). Returns whether
 *  it wrote. A user-owned file (exists, no marker) is preserved. */
function writeOwned(path: string, content: string): boolean {
  if (existsSync(path)) {
    try {
      if (!readFileSync(path, "utf8").includes(MARKER)) return false; // user took ownership — don't clobber
    } catch {
      return false;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

const q = (s: string): string => `"${s}"`;

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

/** Ensure the membership entity carries the columns the RLS helpers + bootstrap rely on. */
function withMembershipColumns(model: DataModel): DataModel {
  if (!model.membershipEntity) return model;
  const entities = model.entities.map((e) => {
    if (e.name !== model.membershipEntity) return e;
    const have = new Set(e.fields.map((f) => f.name));
    const add: Field[] = [];
    if (!have.has("authUserId")) add.push({ name: "authUserId", type: "uuid", nullable: false, unique: true, default: undefined, references: undefined });
    if (!have.has(model.tenantField) && model.tenantEntity) add.push({ name: model.tenantField, type: "uuid", nullable: false, references: model.tenantEntity });
    if (!have.has(model.roleField)) add.push({ name: model.roleField, type: "text", nullable: false, default: `'${model.adminRole}'` });
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

function migrationAuthHelpers(model: DataModel): string {
  if (!model.membershipEntity) return "";
  const m = q(model.membershipEntity);
  const tf = q(model.tenantField);
  const rf = q(model.roleField);
  const hasEmail = model.entities.find((e) => e.name === model.membershipEntity)?.fields.some((f) => f.name === "email");
  const hasName = model.entities.find((e) => e.name === model.membershipEntity)?.fields.some((f) => f.name === "name");
  const cols = ["authUserId", model.tenantField, model.roleField, ...(hasEmail ? ["email"] : []), ...(hasName ? ["name"] : [])];
  const vals = ["new.id", "(new.raw_user_meta_data->>'tenantId')::uuid", `coalesce(new.raw_user_meta_data->>'role','${model.adminRole}')`, ...(hasEmail ? ["new.email"] : []), ...(hasName ? ["new.raw_user_meta_data->>'name'"] : [])];
  return [
    `-- ${MARKER} — auth helpers + first-account bootstrap. SECURITY DEFINER so policies that call`,
    `-- these never re-enter the membership table's own RLS (avoids "stack depth exceeded" recursion).`,
    "",
    `create or replace function auth_tenant_id() returns uuid language sql stable security definer set search_path = public as $$`,
    `  select ${tf} from ${m} where ${q("authUserId")} = auth.uid() limit 1`,
    `$$;`,
    "",
    `create or replace function auth_is_member() returns boolean language sql stable security definer set search_path = public as $$`,
    `  select exists (select 1 from ${m} where ${q("authUserId")} = auth.uid())`,
    `$$;`,
    "",
    `create or replace function auth_is_admin() returns boolean language sql stable security definer set search_path = public as $$`,
    `  select exists (select 1 from ${m} where ${q("authUserId")} = auth.uid() and ${rf} = '${model.adminRole}')`,
    `$$;`,
    "",
    `-- Bootstrap: when an auth user is created with tenant metadata, create their membership row.`,
    `create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public, auth as $$`,
    `begin`,
    `  if new.raw_user_meta_data ? 'tenantId' then`,
    `    insert into ${m} (${cols.map(q).join(", ")}) values (${vals.join(", ")});`,
    `  end if;`,
    `  return new;`,
    `end $$;`,
    `drop trigger if exists on_auth_user_created on auth.users;`,
    `create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();`,
    "",
  ].join("\n");
}

/** The RLS policy block for one entity, from its declared access. Only `FOR ALL ... USING ... WITH
 *  CHECK` and `FOR SELECT ... USING` are emitted — never the invalid multi-command FOR clause. */
function policiesFor(e: Entity, model: DataModel): string[] {
  const t = q(e.name);
  const out = [`alter table ${t} enable row level security;`];
  const tf = q(e.tenantField ?? model.tenantField);
  const owner = q(e.ownerField ?? "authUserId");
  const tenantScoped = !!model.membershipEntity;

  if (e.name === model.tenantEntity) {
    // the tenant root: a member sees their own tenant; an admin manages it.
    out.push(`create policy ${q(e.name + "_member_read")} on ${t} for select using (${q("id")} = auth_tenant_id());`);
    out.push(`create policy ${q(e.name + "_admin_all")} on ${t} for all using (${q("id")} = auth_tenant_id() and auth_is_admin()) with check (${q("id")} = auth_tenant_id() and auth_is_admin());`);
    return out;
  }
  switch (e.access) {
    case "owner":
      out.push(`create policy ${q(e.name + "_owner_all")} on ${t} for all using (${owner} = auth.uid()) with check (${owner} = auth.uid());`);
      break;
    case "tenant":
      if (tenantScoped) out.push(`create policy ${q(e.name + "_tenant_all")} on ${t} for all using (${tf} = auth_tenant_id()) with check (${tf} = auth_tenant_id());`);
      else out.push(`create policy ${q(e.name + "_auth_all")} on ${t} for all using (auth.uid() is not null) with check (auth.uid() is not null);`);
      break;
    case "tenant-admin":
      if (tenantScoped) {
        out.push(`create policy ${q(e.name + "_tenant_read")} on ${t} for select using (${tf} = auth_tenant_id());`);
        out.push(`create policy ${q(e.name + "_admin_write")} on ${t} for all using (${tf} = auth_tenant_id() and auth_is_admin()) with check (${tf} = auth_tenant_id() and auth_is_admin());`);
      } else {
        out.push(`create policy ${q(e.name + "_auth_read")} on ${t} for select using (auth.uid() is not null);`);
      }
      break;
    case "auth":
      out.push(`create policy ${q(e.name + "_auth_read")} on ${t} for select using (auth.uid() is not null);`);
      break;
    case "public":
      out.push(`create policy ${q(e.name + "_public_read")} on ${t} for select using (true);`);
      break;
  }
  return out;
}

function migrationRls(model: DataModel): string {
  const lines = [`-- ${MARKER} — Row-Level Security. Every table is protected; no blanket world-readable`, `-- policies except explicit public reads. Helpers live in the auth migration (SECURITY DEFINER, no recursion).`, ""];
  for (const e of model.entities) lines.push(...policiesFor(e, model), "");
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
}

/** Generate the backend from the model into `target`. Idempotent + generate-then-own. */
export function generateBackend(target: string, rawModel: DataModel): GenerateResult {
  const model = withMembershipColumns(rawModel);
  const files: Array<{ rel: string; content: string }> = [
    { rel: "supabase/migrations/0001_init.sql", content: migrationInit(model) },
  ];
  const auth = migrationAuthHelpers(model);
  if (auth) files.push({ rel: "supabase/migrations/0002_auth.sql", content: auth });
  files.push({ rel: "supabase/migrations/0003_rls.sql", content: migrationRls(model) });
  files.push(
    { rel: "lib/supabase/client.ts", content: CLIENT_BROWSER },
    { rel: "lib/supabase/server.ts", content: CLIENT_SERVER },
    { rel: "lib/supabase/admin.ts", content: CLIENT_ADMIN },
    { rel: "app/api/auth/signin/route.ts", content: SIGNIN_ROUTE },
    { rel: "middleware.ts", content: MIDDLEWARE },
  );
  const written: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    if (writeOwned(join(target, f.rel), f.content)) written.push(f.rel);
    else skipped.push(f.rel);
  }
  return { written, skipped };
}
