/**
 * The PRD trust boundary (PROJECT_BRIEF.md §11: the LLM proposes, deterministic
 * code disposes). An LLM drafts a PRD as free-form JSON; NONE of its shape is
 * trusted. `extractJsonObject` pulls the object out of the model's text (fenced or
 * bare), and `coerceSpec` forces arbitrary parsed JSON into a valid `Spec` — clamping
 * enums, coercing types, filling conservative defaults (unknown auth → "none",
 * unknown tenancy → "single-user"), so a malformed or adversarial draft can never
 * produce an invalid spec that the readiness check then mis-judges. Pure.
 */
import type { DataEntity, Spec, SensitiveClass, Tenancy } from "./spec.ts";

const TENANCIES: readonly Tenancy[] = ["single-user", "single-tenant", "multi-tenant"];
const SENSITIVE: readonly SensitiveClass[] = ["none", "pii", "phi", "financial", "credentials"];

const asStr = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const asBool = (v: unknown, d = false): boolean => (typeof v === "boolean" ? v : d);
const asStrArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];

function coerceEntity(v: unknown): DataEntity | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const name = asStr(o.name).trim();
  if (!name) return null; // an entity with no name is noise — drop it
  return { name, fields: asStrArr(o.fields), sensitive: asBool(o.sensitive) };
}

/** Force any parsed JSON into a valid `Spec`. Conservative defaults so a missing
 *  field never silently looks "safe" (e.g. omitted auth → "none", which the
 *  readiness check then flags for a sensitive app rather than assuming auth exists). */
export function coerceSpec(raw: unknown): Spec {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const tenancy = TENANCIES.includes(o.tenancy as Tenancy) ? (o.tenancy as Tenancy) : "single-user";
  const sensitiveData = (Array.isArray(o.sensitiveData) ? o.sensitiveData : []).filter(
    (x): x is SensitiveClass => SENSITIVE.includes(x as SensitiveClass),
  );
  const dataEntities = (Array.isArray(o.dataEntities) ? o.dataEntities : [])
    .map(coerceEntity)
    .filter((e): e is DataEntity => e !== null);
  return {
    name: asStr(o.name, "untitled-app").trim() || "untitled-app",
    summary: asStr(o.summary),
    features: asStrArr(o.features),
    users: asStr(o.users),
    tenancy,
    auth: asStr(o.auth, "none").trim() || "none",
    storesData: asBool(o.storesData, dataEntities.length > 0),
    dataEntities,
    sensitiveData: sensitiveData.length ? [...new Set(sensitiveData)] : ["none"],
    realUsers: asBool(o.realUsers),
    maintained: asBool(o.maintained),
  };
}

/** Pull the first JSON object out of LLM text — handles a ```json fence, a bare
 *  object, or one wrapped in prose. Throws if there's no object to parse. */
export function extractJsonObject(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? (fence[1] ?? "") : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON object found in intake output");
  return JSON.parse(body.slice(start, end + 1));
}

/** Extract + coerce in one step: untrusted model text → a valid `Spec`. */
export function parseSpec(text: string): Spec {
  return coerceSpec(extractJsonObject(text));
}

/** Like `extractJsonObject` but returns null instead of throwing. For the resilient
 *  LLM path: a malformed model response becomes a degenerate artifact the grill loop
 *  retries (and ultimately reports as "not ready"), never an uncaught crash. */
export function tryExtractJsonObject(text: string): unknown | null {
  try {
    return extractJsonObject(text);
  } catch {
    return null;
  }
}
