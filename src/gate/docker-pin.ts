/**
 * Deterministic Dockerfile base-image digest pinning.
 *
 * Found live 2026-07-04: prod-readiness (unpinned-base-image) tells the fixer to "pin the
 * FROM image by digest," and the LLM complies by hand-writing a plausible-looking
 * `@sha256:...` — which is fabricated, not looked up. A model has no reliable way to know a
 * real registry digest; the result passes the gate's regex check but doesn't correspond to
 * any actual manifest, so Depot fails at the very first build step ("load metadata for
 * FROM") when it can't resolve it. This resolves the REAL current digest for whatever
 * image:tag the Dockerfile names, the same way a lockfile pins a package version — a
 * machine looks it up, the model never has to know it.
 */
// Handles optional `--platform=…` (seen live 2026-07-05: fixer-rewritten Dockerfiles use it, and
// an unmatched FROM line silently stays unpinned).
const FROM_LINE_RE = /^(\s*FROM\s+(?:--platform=\S+\s+)?)([a-zA-Z0-9./_-]+)(:[\w.][\w.-]*)?(@sha256:[a-f0-9]{64})?((?:\s+[Aa][Ss]\s+\S+)?)\s*$/;

/** Injectable so digest resolution is unit-testable offline (same seam as notify.ts's FetchLike). */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

interface RegistryRef {
  registry: string;
  repository: string;
}

function parseImageRef(image: string): RegistryRef {
  const parts = image.split("/");
  const head = parts[0] ?? "";
  if (parts.length === 1) return { registry: "registry-1.docker.io", repository: `library/${head}` };
  const looksLikeHost = head.includes(".") || head.includes(":") || head === "localhost";
  if (looksLikeHost) return { registry: head, repository: parts.slice(1).join("/") };
  return { registry: "registry-1.docker.io", repository: image };
}

/** Resolves the real, currently-published digest for `image:tag` via the Docker Registry
 *  HTTP API v2. Returns null (leave as-is) on any failure — private registries, offline,
 *  or a ref that doesn't exist are all "can't help here," not an error to surface. */
/** In-process (image:tag → digest) cache. The autofix loop normalizes EVERY round and a fix
 *  round often rewrites the Dockerfile; without this, ~3 FROMs × N rounds of anonymous
 *  registry lookups run into Docker Hub rate limits and resolution silently degrades
 *  (observed live 2026-07-05: intermittently-unpinned rounds in one build). Within one build
 *  process a tag's digest staying fixed is exactly what we want anyway. */
const digestCache = new Map<string, string | null>();

/** Test seam: the cache is process-lifetime by design; tests need isolation between cases. */
export function clearDigestCache(): void {
  digestCache.clear();
}

async function resolveDigest(image: string, tag: string, fetchImpl: FetchLike): Promise<string | null> {
  const cacheKey = `${image}:${tag}`;
  const hit = digestCache.get(cacheKey);
  if (hit !== undefined && hit !== null) return hit; // negative results retry — they may be transient (429)
  const ref = parseImageRef(image);
  try {
    let authHeader: string | undefined;
    if (ref.registry === "registry-1.docker.io") {
      const tokenRes = await fetchImpl(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${ref.repository}:pull`);
      if (!tokenRes.ok) return null;
      const body = (await tokenRes.json()) as { token?: string };
      if (!body.token) return null;
      authHeader = `Bearer ${body.token}`;
    }
    const manifestRes = await fetchImpl(`https://${ref.registry}/v2/${ref.repository}/manifests/${tag}`, {
      headers: {
        ...(authHeader ? { Authorization: authHeader } : {}),
        // Ask for a multi-arch index first (what most base images publish); fall back to a
        // single-platform manifest for images that only ever ship one.
        Accept:
          "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
      },
    });
    if (!manifestRes.ok) return null;
    const digest = manifestRes.headers.get("docker-content-digest");
    const out = digest && /^sha256:[a-f0-9]{64}$/.test(digest) ? digest : null;
    if (out) digestCache.set(cacheKey, out);
    return out;
  } catch {
    return null;
  }
}

/** Rewrites every registry-image `FROM` line to carry its real, resolved digest — including
 *  replacing a fabricated one that doesn't match what the registry actually serves. Leaves
 *  multi-stage `FROM <earlier-stage> AS x` references untouched (no registry lookup for those). */
export async function pinDockerfileDigests(dockerfile: string, fetchImpl: FetchLike = fetch): Promise<{ content: string; changed: boolean; unresolved: string[] }> {
  const lines = dockerfile.split("\n");
  const stageNames = new Set<string>();
  const unresolved: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = FROM_LINE_RE.exec(line);
    if (!m) continue;
    const prefix = m[1] ?? "";
    const image = m[2] ?? "";
    const tagPart = m[3];
    const existingDigest = m[4];
    const asPart = m[5] ?? "";
    const stageMatch = /\s+AS\s+(\S+)/i.exec(asPart);
    const stageName = stageMatch?.[1];
    if (stageName) stageNames.add(stageName);
    if (stageNames.has(image) && !tagPart && !existingDigest) continue; // references an earlier build stage
    const tag = tagPart ? tagPart.slice(1) : "latest";
    const digest = await resolveDigest(image, tag, fetchImpl);
    if (!digest) {
      // Couldn't resolve — leave as-is rather than guess, but SAY so: a silently-unpinned
      // line reads as "normalize ran and chose not to", which cost a whole live diagnosis.
      unresolved.push(`${image}:${tag}`);
      continue;
    }
    const rewritten = `${prefix}${image}:${tag}@${digest}${asPart}`;
    if (rewritten !== line) changed = true;
    lines[i] = rewritten;
  }
  return { content: lines.join("\n"), changed, unresolved };
}
