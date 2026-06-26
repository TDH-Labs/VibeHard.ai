/**
 * Deterministic DEMO-SEED generator (roadmap Phase 2). From the same structured DataModel that
 * drives the backend, emit a `scripts/seed.ts` that fills a fresh project with believable sample
 * data — so a build looks ALIVE the instant it opens (the thing that made Base44/Lovable feel real
 * and our empty AcmeCare feel broken; it also prevents the empty-dropdown class of "looks broken").
 *
 * The generated script runs with the service-role key: it creates a demo tenant, a demo admin login
 * (via auth.admin.createUser whose metadata trips the generated bootstrap trigger → a membership
 * row), then inserts FK-aware sample rows for every entity in dependency order (a child row's FK
 * resolves to a parent row already seeded). Generate-then-own (a marker preserves a hand-edited
 * seed). The generation is deterministic + unit-tested; running it needs live Supabase (preview/ship).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DataModel, Entity, Field } from "./model.ts";

const MARKER = "@vibehard:generated";

function writeOwned(path: string, content: string): boolean {
  if (existsSync(path)) {
    try {
      if (!readFileSync(path, "utf8").includes(MARKER)) return false;
    } catch {
      return false;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

/** Topo order so a row's FK targets are seeded before it (same ordering rule as the migrations). */
function seedOrder(entities: Entity[]): Entity[] {
  const byName = new Map(entities.map((e) => [e.name, e]));
  const out: Entity[] = [];
  const done = new Set<string>();
  const remaining = new Set(entities.map((e) => e.name));
  let guard = 0;
  while (remaining.size && guard++ < entities.length + 2) {
    const ready = [...remaining].filter((n) => byName.get(n)!.fields.every((f) => !f.references || done.has(f.references) || f.references === n || !byName.has(f.references)));
    const take = ready.length ? ready : [[...remaining][0]!]; // break cycles deterministically
    for (const n of take) {
      out.push(byName.get(n)!);
      done.add(n);
      remaining.delete(n);
    }
  }
  return out;
}

/** A JS expression (string) for one field's value in row `i` of `entity`, evaluated in the script. */
function valueExpr(model: DataModel, entity: Entity, f: Field): string {
  const ownerField = entity.ownerField ?? "authUserId";
  if (model.tenantEntity && (f.references === model.tenantEntity || f.name === (entity.tenantField ?? model.tenantField))) return "tenantId";
  if (f.name === ownerField || f.name === "authUserId") return "adminUserId";
  if (f.references) return `pickId(${JSON.stringify(f.references)})`;
  const n = f.name.toLowerCase();
  if (n.includes("email")) return "`person${i}@example.com`";
  if (n === "name" || n.endsWith("name")) return "fullName(i)";
  if (n.includes("phone")) return "`555-01${String(10 + i).slice(-2)}`";
  if (n.includes("status")) return "'active'";
  switch (f.type) {
    case "integer":
      return "(1 + i)";
    case "numeric":
      return "(250 + i * 75)";
    case "boolean":
      return "i % 2 === 0";
    case "timestamptz":
    case "date":
      return "new Date(Date.now() - i * 86400000).toISOString()";
    case "jsonb":
      return "{}";
    case "text[]":
      return "[]";
    default:
      return `\`${entity.name} \${i + 1}\``;
  }
}

function seedScript(model: DataModel, rows = 4): string {
  const lines = [
    `// ${MARKER} — demo seed. Run with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set.`,
    `import { createClient } from '@supabase/supabase-js';`,
    `const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });`,
    `const ids: Record<string, string[]> = {};`,
    `const pickId = (e: string) => { const a = ids[e] ?? []; return a.length ? a[Math.floor((a.length) / 2)] : null; };`,
    `const FIRST = ['Sarah','Michael','Emily','David','Olivia','James','Sophia','Liam'];`,
    `const LAST = ['Johnson','Chen','Rodriguez','Park','Nguyen','Patel','Garcia','Khan'];`,
    `const fullName = (i: number) => \`\${FIRST[i % FIRST.length]} \${LAST[(i * 3) % LAST.length]}\`;`,
    ``,
    `async function insert(table: string, row: Record<string, unknown>) {`,
    `  const { data, error } = await sb.from(table).insert(row).select('id').single();`,
    `  if (error) { console.error(table, error.message); return; }`,
    `  (ids[table] ??= []).push(data.id);`,
    `}`,
    ``,
    `async function main() {`,
  ];

  let tenantSetup = "  const tenantId: string | null = null;";
  if (model.tenantEntity) {
    const te = model.entities.find((e) => e.name === model.tenantEntity);
    const tenantFields = (te?.fields ?? []).filter((f) => !f.references).map((f) => `${JSON.stringify(f.name)}: ${valueExpr(model, te!, f)}`);
    tenantSetup = [
      `  // 1) the demo tenant`,
      `  const { data: t, error: te } = await sb.from(${JSON.stringify(model.tenantEntity)}).insert({ ${["name: 'Demo Organization'", ...tenantFields.filter((x) => !x.startsWith('"name"'))].join(", ")} }).select('id').single();`,
      `  if (te) { console.error('tenant', te.message); return; }`,
      `  const tenantId = t.id as string;`,
      `  (ids[${JSON.stringify(model.tenantEntity)}] ??= []).push(tenantId);`,
    ].join("\n");
  }
  lines.push(tenantSetup, "");

  // admin login + membership (via the generated bootstrap trigger)
  lines.push(
    `  // 2) a demo admin login — the auth-user metadata trips the bootstrap trigger → a membership row`,
    `  let adminUserId: string | null = null;`,
    `  const adminEmail = 'admin@demo.test', adminPassword = 'Demo!passw0rd';`,
    // tenant + role go in app_metadata (service-role only) — the bootstrap trigger trusts ONLY that,
    // never user_metadata (which a real client could forge at signup). Display name is non-privileged.
    `  const { data: u, error: ue } = await sb.auth.admin.createUser({ email: adminEmail, password: adminPassword, email_confirm: true, app_metadata: { tenantId, role: ${JSON.stringify(model.adminRole)} }, user_metadata: { name: 'Demo Admin' } });`,
    `  if (ue) console.error('admin', ue.message); else adminUserId = u.user.id;`,
    `  await new Promise((r) => setTimeout(r, 800));`,
    "",
  );

  // feature data: every entity except the tenant root (its membership is created by the trigger)
  const seedable = seedOrder(model.entities).filter((e) => e.name !== model.tenantEntity && e.name !== model.membershipEntity);
  lines.push(`  // 3) sample rows (FK-aware, in dependency order)`);
  for (const e of seedable) {
    const cols = e.fields.map((f) => `        ${JSON.stringify(f.name)}: ${valueExpr(model, e, f)}`);
    lines.push(`  for (let i = 0; i < ${rows}; i++) {`, `    await insert(${JSON.stringify(e.name)}, {`, cols.join(",\n"), "    });", "  }");
  }
  lines.push(
    "",
    `  console.log('✓ demo data seeded — login:', adminEmail, '/', adminPassword);`,
    `}`,
    `main().then(() => process.exit(0));`,
    "",
  );
  return lines.join("\n");
}

export interface SeedResult {
  written: boolean;
  rel: string;
}

/** Write the demo seed script for `model` into `target`. Generate-then-own. */
export function generateSeed(target: string, model: DataModel, rows = 4): SeedResult {
  const rel = "scripts/seed.ts";
  return { written: writeOwned(join(target, rel), seedScript(model, rows)), rel };
}

export const _internal = { seedScript, seedOrder, valueExpr };
