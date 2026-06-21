/**
 * Translation (PROJECT_BRIEF.md §15 "Translation" — highest near-term value).
 * Maps a structured `Finding` to a plain-English `Explanation` for a non-technical
 * operator. Deterministic-cored (curated dictionary + keyword families); an
 * injectable `Translator` seam covers the open-ended scanner long-tail with an LLM
 * later (§11: the LLM only *interprets* here — it never gates).
 *
 * Invariant: `translateFinding` ALWAYS returns — a finding is never left
 * unexplained (a blocked user must always be told, in plain terms, what's wrong).
 */
import type { Finding } from "../types.ts";
import { BY_TOOL, EXACT, KEYWORDS, type Entry } from "./dictionary.ts";

export interface Explanation extends Entry {
  /** The finding this explains (echoed for reference). */
  ruleId: string;
  /** Where the explanation came from — for transparency and testing. */
  source: "dictionary" | "heuristic" | "generic" | "llm";
}

/** An optional async enricher (e.g. an LLM) for findings the dictionary can't place. */
export type Translator = (finding: Finding) => Promise<Explanation> | Explanation;

/** Find an EXACT entry: try the whole ruleId, then any EXACT key that appears in it
 *  (semgrep ids are long/namespaced, e.g. `…detected-stripe-api-key…`). */
function exactMatch(ruleId: string): Entry | undefined {
  if (EXACT[ruleId]) return EXACT[ruleId];
  const lower = ruleId.toLowerCase();
  for (const key in EXACT) if (lower.includes(key)) return EXACT[key];
  return undefined;
}

function keywordMatch(ruleId: string): Entry | undefined {
  const lower = ruleId.toLowerCase();
  for (const { keys, entry } of KEYWORDS) if (keys.some((k) => lower.includes(k))) return entry;
  return undefined;
}

/** Last resort: a generic but honest explanation, so nothing is ever unexplained. */
function generic(f: Finding): Explanation {
  return {
    ruleId: f.ruleId,
    title: "A potential issue was found that needs a closer look",
    detail: `Our ${f.tool} check flagged a ${f.severity} issue (${f.ruleId}). We couldn't auto-translate this one into plain terms — a reviewer can confirm what it means and what to do.`,
    source: "generic",
  };
}

/** Synchronous, deterministic translation: exact → keyword → tool → generic.
 *  Always returns. */
export function translateFinding(f: Finding): Explanation {
  const exact = exactMatch(f.ruleId);
  if (exact) return { ...exact, ruleId: f.ruleId, source: "dictionary" };
  const kw = keywordMatch(f.ruleId);
  if (kw) return { ...kw, ruleId: f.ruleId, source: "heuristic" };
  const byTool = BY_TOOL[f.tool];
  if (byTool) return { ...byTool, ruleId: f.ruleId, source: "dictionary" };
  return generic(f);
}

/**
 * Translate a batch. Deterministic by default; if a `translator` is supplied it
 * enriches ONLY the findings the dictionary couldn't place (source === "generic"),
 * so the curated content always wins and the LLM is a bounded fallback.
 */
export async function translateFindings(findings: Finding[], translator?: Translator): Promise<Explanation[]> {
  const out: Explanation[] = [];
  for (const f of findings) {
    const base = translateFinding(f);
    out.push(base.source === "generic" && translator ? await translator(f) : base);
  }
  return out;
}
