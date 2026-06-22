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
  if (spec.storesData && !ownsDataLayer(arch)) {
    out.push(
      f(
        "architecture-misses-data-layer",
        isSensitive(spec) ? "high" : "medium",
        `The app stores data${isSensitive(spec) ? " (sensitive)" : ""} but no workstream owns the database schema/migration — the data model${isSensitive(spec) ? " and its RLS" : ""} has nowhere to live.`,
      ),
    );
  }

  // 3. Don't rebuild a commodity buy-vs-build said to BUY (advisory — a heuristic nudge).
  for (const b of prd.buyVsBuild) {
    if (b.recommendation !== "buy") continue;
    const key = b.category.toLowerCase().split(/[^a-z]+/).filter(Boolean)[0];
    if (!key) continue;
    const re = new RegExp(`\\b${key}`, "i");
    if (arch.workstreams.some((w) => re.test(w.name) || re.test(w.responsibility))) {
      out.push(
        f("builds-what-should-be-bought", "medium", `A workstream appears to build "${b.category}", which buy-vs-build recommends buying (${b.service}). Confirm you mean to build it rather than integrate.`),
      );
    }
  }

  return out;
}
