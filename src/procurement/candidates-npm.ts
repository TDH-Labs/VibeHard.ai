/**
 * Candidate discovery — the part that ACTUALLY LOOKS. Two live, KEYLESS sources:
 *   • registryCandidateSource — the curated paid/hosted services (the "buy" side).
 *   • npmSearchCandidateSource — the npm registry search API (the OSS side).
 * Both are injectable seams; the live HTTP is gated behind `fetchImpl` so unit tests
 * use a fake and never hit the network. Failures degrade to an empty list (the advisor
 * simply has fewer options), never throw.
 */
import type { Candidate, CandidateSource } from "./types.ts";

/** The curated services from buy-vs-build, as candidates. Pure — no network. */
export const registryCandidateSource: CandidateSource = async (cap) =>
  cap.knownServices.map((name) => ({ kind: "service", name, source: "registry" }));

interface NpmSearchResponse {
  objects?: Array<{
    package?: {
      name?: unknown;
      description?: unknown;
      links?: { repository?: unknown; homepage?: unknown };
    };
  }>;
}

export interface NpmSearchOptions {
  limit?: number;
  fetchImpl?: typeof fetch;
}

/** Discover OSS packages via npm's keyless search API (registry.npmjs.org/-/v1/search). */
export function npmSearchCandidateSource(opts: NpmSearchOptions = {}): CandidateSource {
  const limit = opts.limit ?? 5;
  const doFetch = opts.fetchImpl ?? fetch;
  return async (cap) => {
    const text = (cap.searchTerms.length ? cap.searchTerms : [cap.key]).join(" ");
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${limit}`;
    try {
      const res = await doFetch(url);
      if (!res.ok) return [];
      const data = (await res.json()) as NpmSearchResponse;
      const out: Candidate[] = [];
      for (const o of data.objects ?? []) {
        const name = typeof o.package?.name === "string" ? o.package.name : null;
        if (!name) continue;
        out.push({
          kind: "package",
          name,
          source: "npm-search",
          ecosystem: "npm",
          description: typeof o.package?.description === "string" ? o.package.description : undefined,
          repoUrl: typeof o.package?.links?.repository === "string" ? o.package.links.repository : undefined,
          homepage: typeof o.package?.links?.homepage === "string" ? o.package.links.homepage : undefined,
        });
      }
      return out;
    } catch {
      return [];
    }
  };
}

/** Run several sources and concatenate (services + OSS). */
export function combinedCandidateSource(...sources: CandidateSource[]): CandidateSource {
  return async (cap) => (await Promise.all(sources.map((s) => s(cap)))).flat();
}
