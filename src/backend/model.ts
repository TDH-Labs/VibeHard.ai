/**
 * The structured DATA MODEL — the LLM's one job in the backend (propose the model); deterministic
 * code (generate.ts) disposes the actual migrations/RLS/auth/clients. This is "LLM proposes,
 * deterministic disposes" applied to the layer that, when LLM-authored, produced every backend bug
 * this project has hit (invalid FOR clauses, forward FKs, function-before-table ordering, RLS
 * recursion). A typed model + a generator makes those bug classes unrepresentable.
 *
 * Pure types + a trust-boundary coercer (mirrors src/spec/coerce.ts / functest coerceChecks): a
 * malformed model is repaired or dropped, never trusted raw.
 */

/** Postgres column types we generate. Kept small + safe; unknown types coerce to text. */
export type FieldType = "uuid" | "text" | "text[]" | "integer" | "numeric" | "boolean" | "timestamptz" | "date" | "jsonb";
const FIELD_TYPES: readonly FieldType[] = ["uuid", "text", "text[]", "integer", "numeric", "boolean", "timestamptz", "date", "jsonb"];

export interface Field {
  name: string;
  type: FieldType;
  nullable: boolean;
  /** raw SQL default, e.g. "now()", "'{}'::jsonb", "false". Optional. */
  default?: string;
  /** entity name this column is a FK to (→ that entity's id). Implies type uuid. */
  references?: string;
  unique?: boolean;
}

/** How rows are protected — drives the RLS template (the whole point). */
export type Access =
  | "owner" // the row's owner column = auth.uid() (e.g. a user's own notes)
  | "tenant" // scoped to the caller's tenant; any member reads+writes
  | "tenant-admin" // tenant-scoped reads for members; writes are admin-only
  | "auth" // any authenticated user (shared reference data)
  | "public"; // world-readable (rare)
const ACCESS: readonly Access[] = ["owner", "tenant", "tenant-admin", "auth", "public"];

export interface Entity {
  name: string; // PascalCase → quoted table name, e.g. "Child"
  fields: Field[]; // implicit id + createdAt are added by the generator; don't list them
  access: Access;
  /** owner column (access "owner"). Default "authUserId". */
  ownerField?: string;
  /** tenant column (access "tenant"/"tenant-admin"). Default = the model's tenantField. */
  tenantField?: string;
}

export interface DataModel {
  /** The tenant root table (e.g. "Center"); omit for single-user apps. */
  tenantEntity?: string;
  /** The membership table linking auth.users → tenant + role (e.g. "Staff"). Required for tenant
   *  scoping: the recursion-safe helpers read it. Must have authUserId + the tenant column + role. */
  membershipEntity?: string;
  /** Column on the membership entity holding the tenant id. Default "centerId". */
  tenantField: string;
  /** Column on the membership entity holding the role. Default "role". */
  roleField: string;
  /** Role value that counts as admin. Default "admin". */
  adminRole: string;
  entities: Entity[];
}

const ident = (s: unknown): string => (typeof s === "string" ? s.trim() : "").replace(/[^A-Za-z0-9_]/g, "");

/** Resolve an FK reference to one of OUR entity names. LLMs write it as "Entity", "table.column", or
 *  "schema.table.column" (e.g. "users.id") — `ident` alone mangles the dotted forms to nonsense and
 *  the FK gets silently dropped, which both loses integrity constraints AND defeats owner-scoped RLS.
 *  Supabase's `auth.users.*` is linked via authUserId, not an app FK, so it resolves to nothing. */
function resolveRef(raw: unknown, entityNames: Set<string>): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  if (/^auth\s*\./i.test(raw.trim())) return undefined; // the Supabase auth schema — not one of our tables
  const segs = raw.split(".").map((x) => x.replace(/[^A-Za-z0-9_]/g, "")).filter(Boolean);
  if (segs.length === 1 && entityNames.has(segs[0]!)) return segs[0]; // bare "Entity"
  if (segs.length >= 2 && entityNames.has(segs[segs.length - 2]!)) return segs[segs.length - 2]; // table.column → table
  return segs.find((x) => entityNames.has(x)); // last-ditch: any segment naming an entity
}

function coerceField(raw: unknown, entityNames: Set<string>): Field | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = ident(r.name);
  if (!name) return null;
  const validRef = resolveRef(r.references, entityNames);
  let type = FIELD_TYPES.includes(r.type as FieldType) ? (r.type as FieldType) : "text";
  if (validRef) type = "uuid"; // a FK is always a uuid
  return {
    name,
    type,
    nullable: r.nullable !== false ? r.nullable === true : false, // default NOT NULL unless explicitly true
    default: typeof r.default === "string" && r.default.trim() ? r.default.trim() : undefined,
    references: validRef,
    unique: r.unique === true,
  };
}

/** Trust boundary: coerce arbitrary (LLM) JSON into a valid DataModel. Invalid entities/fields are
 *  dropped; references to non-existent entities are dropped; sensible defaults fill the rest. */
export function coerceDataModel(raw: unknown): DataModel {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawEntities = Array.isArray(o.entities) ? o.entities : [];
  // First pass: collect valid entity names so FK references can be validated.
  const names = new Set<string>();
  for (const e of rawEntities) {
    if (e && typeof e === "object") {
      const n = ident((e as Record<string, unknown>).name);
      if (n) names.add(n);
    }
  }
  const entities: Entity[] = [];
  const seen = new Set<string>();
  for (const e of rawEntities) {
    if (!e || typeof e !== "object") continue;
    const r = e as Record<string, unknown>;
    const name = ident(r.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const fields = (Array.isArray(r.fields) ? r.fields : []).map((f) => coerceField(f, names)).filter((f): f is Field => !!f);
    const access: Access = ACCESS.includes(r.access as Access) ? (r.access as Access) : "auth";
    entities.push({
      name,
      fields,
      access,
      ownerField: r.ownerField ? ident(r.ownerField) : undefined,
      tenantField: r.tenantField ? ident(r.tenantField) : undefined,
    });
  }
  const tenantField = ident(o.tenantField) || "centerId";
  const membershipEntity = o.membershipEntity && names.has(ident(o.membershipEntity)) ? ident(o.membershipEntity) : undefined;
  const tenantEntity = o.tenantEntity && names.has(ident(o.tenantEntity)) ? ident(o.tenantEntity) : undefined;
  return {
    tenantEntity,
    membershipEntity,
    tenantField,
    roleField: ident(o.roleField) || "role",
    adminRole: typeof o.adminRole === "string" && o.adminRole.trim() ? o.adminRole.trim() : "admin",
    entities,
  };
}
