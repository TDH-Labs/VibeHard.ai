/**
 * The evidence layer — DETERMINISTIC, FACTUAL signals about an OSS candidate, from
 * KEYLESS public sources (npm registry + deps.dev, Google's Open Source Insights, which
 * also surfaces the GitHub source repo and its OpenSSF Scorecard + known advisories).
 *
 * Practicing what the tool preaches: we did NOT build a crawler — we integrate deps.dev.
 * Defensive throughout: external JSON is untrusted, any field may be missing, and any
 * failure returns null (→ assessSafety treats "unverifiable" as unsafe — fail-closed).
 */
import { categorizeLicense } from "./assess.ts";
import type { Candidate, Evidence, EvidenceProvider } from "./types.ts";

const DAY_MS = 86_400_000;

// ── safe accessors over untrusted JSON ───────────────────────────────────────
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" ? (x as Record<string, unknown>) : {});
const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

export interface DepsDevOptions {
  fetchImpl?: typeof fetch;
  /** ISO "now" for staleness; defaults to the wall clock (this is live I/O, not pure). */
  nowISO?: string;
}

async function safeJson(doFetch: typeof fetch, url: string): Promise<unknown> {
  try {
    const res = await doFetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** npm `license` can be a string, `{type}`, or legacy `licenses:[{type}]`. */
function npmLicense(npm: Record<string, unknown>): string | null {
  if (str(npm.license)) return str(npm.license);
  const lt = str(obj(npm.license).type);
  if (lt) return lt;
  const legacy = arr(npm.licenses)[0];
  return legacy ? str(obj(legacy).type) : null;
}

function npmLatest(npm: Record<string, unknown>): string | null {
  return str(obj(npm["dist-tags"]).latest);
}

function npmLastRelease(npm: Record<string, unknown>): string | null {
  const time = obj(npm.time);
  const latest = npmLatest(npm);
  return (latest ? str(time[latest]) : null) ?? str(time.modified);
}

function npmDeprecated(npm: Record<string, unknown>): boolean {
  const latest = npmLatest(npm);
  if (!latest) return false;
  const ver = obj(obj(npm.versions)[latest]);
  return typeof ver.deprecated === "string" && ver.deprecated.length > 0;
}

/** deps.dev package → the default version string. */
function defaultVersion(dd: Record<string, unknown>): string | null {
  for (const v of arr(dd.versions)) {
    const vo = obj(v);
    if (vo.isDefault === true) return str(obj(vo.versionKey).version);
  }
  const first = arr(dd.versions)[0];
  return first ? str(obj(obj(first).versionKey).version) : null;
}

/** deps.dev version → SOURCE_REPO project id (e.g. "github.com/foo/bar"). */
function sourceProjectKey(ver: Record<string, unknown>): string | null {
  for (const rp of arr(ver.relatedProjects)) {
    const rpo = obj(rp);
    if (rpo.relationType === "SOURCE_REPO") return str(obj(rpo.projectKey).id);
  }
  const first = arr(ver.relatedProjects)[0];
  return first ? str(obj(obj(first).projectKey).id) : null;
}

/**
 * Gather evidence for an npm package candidate. Combines the npm registry doc (license,
 * deprecation, last publish) with deps.dev (SPDX licenses, advisories, OpenSSF Scorecard
 * via the linked source project).
 */
export function depsDevEvidenceProvider(opts: DepsDevOptions = {}): EvidenceProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (cand: Candidate): Promise<Evidence | null> => {
    if (cand.kind !== "package" || cand.ecosystem !== "npm") return null;
    const now = opts.nowISO ? Date.parse(opts.nowISO) : Date.now();
    const enc = encodeURIComponent(cand.name);

    const npm = obj(await safeJson(doFetch, `https://registry.npmjs.org/${enc}`));
    const downloads = obj(await safeJson(doFetch, `https://api.npmjs.org/downloads/point/last-month/${enc}`));
    const dd = obj(await safeJson(doFetch, `https://api.deps.dev/v3/systems/npm/packages/${enc}`));
    const ver = defaultVersion(dd)
      ? obj(await safeJson(doFetch, `https://api.deps.dev/v3/systems/npm/packages/${enc}/versions/${encodeURIComponent(defaultVersion(dd)!)}`))
      : {};
    const projKey = sourceProjectKey(ver);
    const project = projKey ? obj(await safeJson(doFetch, `https://api.deps.dev/v3/projects/${encodeURIComponent(projKey)}`)) : {};

    // nothing came back at all → unverifiable
    if (!npmLicense(npm) && Object.keys(ver).length === 0 && Object.keys(project).length === 0) return null;

    const ddLicense = str(arr(ver.licenses)[0]);
    const license = ddLicense ?? npmLicense(npm);
    const lastReleaseISO = npmLastRelease(npm);
    const ageDays = lastReleaseISO ? Math.max(0, Math.round((now - Date.parse(lastReleaseISO)) / DAY_MS)) : null;
    const scorecard = num(obj(project.scorecard).overallScore);

    return {
      license,
      licenseCategory: categorizeLicense(license),
      lastReleaseISO,
      ageDays,
      deprecated: npmDeprecated(npm),
      archived: false, // deps.dev doesn't reliably expose archival; advisories + scorecard carry the risk signal
      advisories: arr(ver.advisoryKeys).length,
      scorecard,
      adoption: num(downloads.downloads), // npm last-month downloads (best-effort; null for some scoped pkgs)
    };
  };
}
