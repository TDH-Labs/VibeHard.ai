/**
 * Front-half cross-consistency checks (the deterministic half of the adversarial
 * review). The per-stage reviews (reviewSpec / reviewPrd / reviewArchitecture) check
 * each artifact in isolation; these check that the artifacts AGREE — that the chain
 * spec → PRD → architecture didn't drop, contradict, or fail to realize something.
 *
 * These are OBJECTIVE rules, so they can BLOCK (unlike the LLM red-team, which is
 * judgment → advisory, §11). They're the front-half analog of the back-half gates:
 * an adversary that attacks the *plan*, where a flaw is cheapest to fix.
 */
import type { Finding } from "../types.ts";
import { isSensitive, type Spec } from "../spec/index.ts";
import type { Prd } from "../prd/index.ts";
import type { Architecture } from "../architecture/index.ts";

const f = (ruleId: string, severity: Finding["severity"], message: string): Finding => ({
  tool: "spec-review",
  ruleId,
  severity,
  file: "front-half",
  message,
});

const ownsDataLayer = (arch: Architecture): boolean =>
  arch.workstreams.some(
    (w) => w.files.some((file) => /migration|schema|\.sql$/i.test(file)) || /\b(schema|migration|database|db|rls)\b/i.test(w.responsibility),
  );

export function crossCheck(spec: Spec, prd: Prd, arch: Architecture): Finding[] {
  const out: Finding[] = [];

  // 1. The PRD must carry every spec feature forward — the chain mustn't silently drop one.
  const covered = new Set(prd.requirements.map((r) => r.feature));
  const dropped = spec.features.filter((ft) => !covered.has(ft));
  if (dropped.length) {
    out.push(f("prd-misses-spec-feature", "high", `The PRD dropped spec feature(s): ${dropped.join("; ")} — they'd never be built.`));
  }

  // 2. A data app must have a workstream that owns the schema/migration — otherwise the
  //    data model (and the RLS the gates require) has nowhere to live. Worse for sensitive.
  //    clientOnlyStorage is the deliberate exception (2026-07-17, observed on both e2e-9 and
  //    e2e-11): everything persists in the browser, so there IS no database layer to own —
  //    firing here contradicts the client-only-app-has-backend check, which BLOCKS the exact
  //    "fix" this finding suggests. A check pair that disagrees teaches the operator to ignore
  //    one of them.
  if (spec.storesData && spec.clientOnlyStorage !== true && !ownsDataLayer(arch)) {
    out.push(
      f(
        "architecture-misses-data-layer",
        isSensitive(spec) ? "high" : "medium",
        `The app stores data${isSensitive(spec) ? " (sensitive)" : ""} but no workstream owns the database schema/migration — the data model${isSensitive(spec) ? " and its RLS" : ""} has nowhere to live.`,
      ),
    );
  }

  // 3. Don't rebuild a commodity buy-vs-build said to BUY (advisory — a heuristic nudge).
  // A workstream NAME matching the category isn't evidence of a violation by itself — "auth" is
  // the workstream every app needs whether it's hand-rolled OR wired to Supabase Auth (itself an
  // accepted buy option, see buy-vs-build.ts). Check the architecture's OWN declared stack for
  // ANY accepted service in the category first; only fire when the stack gives no evidence any
  // of them were actually adopted. (Found 2026-07-04: this fired on every build regardless of
  // outcome — including ones that correctly used Resend/Supabase Auth — because it never looked
  // past the workstream's name. A finding nobody can ever satisfy isn't a check, it's noise.)
  const stackLower = arch.stack.toLowerCase();
  const stackEvidencesService = (service: string): boolean => service.toLowerCase().split(/\s+/).some((word) => stackLower.includes(word));
  for (const b of prd.buyVsBuild) {
    if (b.recommendation !== "buy") continue;
    if (b.services.some(stackEvidencesService)) continue; // the stack already names an accepted option — bought, not built
    const key = b.category.toLowerCase().split(/[^a-z]+/).filter(Boolean)[0];
    if (!key) continue;
    const re = new RegExp(`\\b${key}`, "i");
    if (arch.workstreams.some((w) => re.test(w.name) || re.test(w.responsibility))) {
      out.push(
        f("builds-what-should-be-bought", "medium", `A workstream appears to build "${b.category}", and the architecture's stack doesn't name ${b.services.join("/")} or any other accepted option — confirm you mean to hand-build it rather than integrate.`),
      );
    }
  }

  return out;
}
