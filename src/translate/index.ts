/**
 * Translation layer (PROJECT_BRIEF.md §15). Finding → plain English for the
 * non-technical operator — the curated content asset + an LLM-fallback seam.
 */
export { translateFinding, translateFindings, type Explanation, type Translator } from "./translate.ts";
export { BY_TOOL, EXACT, KEYWORDS, type Entry } from "./dictionary.ts";
export { llmTranslator } from "./translate-llm.ts";
