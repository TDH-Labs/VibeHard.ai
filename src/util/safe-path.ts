/**
 * Path-component safety for caller-supplied identifiers (CRITICAL-1 fix). The web layer joins a
 * tenant-supplied `app` name into `~/.vibehard/tenants/<tenant>/apps/<app>/…`. If `app` is taken
 * raw, a value like `../<otherTenant>/apps/x` traverses OUT of the caller's tenant directory and
 * reads/writes/execs in another tenant's workspace (cross-tenant IDOR + RCE). VALIDATE, never
 * coerce: coercing `../` to `__` would silently change the name and break legitimate lookups, so we
 * reject instead.
 *
 * A legitimate app name is what the builder mints — `app-<base36>` — plus any reasonable
 * user-visible slug. The rule: a single path segment of safe characters, no separators, no `..`,
 * not dot-leading, bounded length. Anything else is refused.
 */
const SAFE_APP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafeAppName(app: unknown): app is string {
  if (typeof app !== "string") return false;
  if (!SAFE_APP.test(app)) return false;
  if (app.includes("..")) return false; // belt-and-suspenders vs the regex
  if (app.includes("/") || app.includes("\\") || app.includes("\0")) return false;
  return true;
}
