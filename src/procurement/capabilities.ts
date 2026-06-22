/**
 * Derive the capabilities to research from a Spec. v1 seeds from the commodity
 * categories buy-vs-build already detects (each becomes a capability with its curated
 * service on the "buy" side and search terms for OSS discovery). Researching arbitrary
 * free-text features is a follow-up — these commodity capabilities are exactly where a
 * non-technical operator most needs the make-vs-buy guidance.
 */
import { buyVsBuild } from "../prd/buy-vs-build.ts";
import type { Spec } from "../spec/index.ts";
import type { Capability } from "./types.ts";

/** Split a category label into OSS search terms ("email & notifications" → email, notifications). */
function termsFor(category: string): string[] {
  const stop = new Set(["and", "the", "for"]);
  return [...new Set(category.split(/[^a-z0-9]+/i).map((w) => w.toLowerCase()).filter((w) => w.length > 2 && !stop.has(w)))];
}

export function capabilitiesFromSpec(spec: Spec): Capability[] {
  return buyVsBuild(spec).map((b) => ({
    key: b.category,
    need: `${spec.name} needs ${b.category} (implied by the spec)`,
    searchTerms: termsFor(b.category),
    knownServices: [b.service],
  }));
}
