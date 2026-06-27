/**
 * Prompt-injection sanitizer for UNTRUSTED text that reaches an LLM (audit2 fleet-injection, hardened
 * in audit3 HIGH-2). Two consumers: the induction prompt (build-error evidence) and the codegen system
 * prompt (an approved convention rule). Both originate from generated, prompt-influenced app output, so
 * a build error / a slipped-through rule can carry injection.
 *
 * Defenses, in order:
 *   1. NFKC normalize + strip zero-width/invisible chars + fold Cyrillic/Greek homoglyphs to Latin —
 *      so `Іgnore` (Cyrillic І), `ig​nore`, and full-width variants can't dodge the matcher.
 *   2. Collapse ALL whitespace (incl. newlines) to single spaces — so a multi-line split
 *      (`ignore\nprevious\ninstructions`) can't slip between `[^\n]` gaps.
 *   3. Neutralize code fences that could break a delimiter, then redact instruction-injection cues.
 *   4. Bound length.
 *
 * This is best-effort defense-in-depth (the induction output is still human-gated); the goal is to keep
 * the injection out of the model's context to begin with.
 */

/** Cyrillic / Greek letters that look like Latin — folded to their Latin lookalike for matching. */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic lower
  а: "a", е: "e", о: "o", с: "c", р: "p", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", к: "k", м: "m", т: "t", н: "h", ԁ: "d", ԍ: "g", ո: "n",
  // Cyrillic upper
  А: "A", Е: "E", О: "O", С: "C", Р: "P", У: "Y", Х: "X", І: "I", Ј: "J", Ѕ: "S", К: "K", М: "M", Т: "T", Н: "H", В: "B",
  // Greek
  ο: "o", α: "a", ε: "e", ρ: "p", ν: "v", ι: "i", τ: "t", υ: "u", κ: "k", Ο: "O", Α: "A", Ε: "E", Ρ: "P", Τ: "T", Κ: "K", Ι: "I",
};

/** Instruction-injection cues — vocabulary widened in audit3 (reset/override/supersede/directives/
 *  guidelines/from now on/act as/pretend). Runs AFTER whitespace is collapsed, so `.*?` is safe. */
const INJECTION_RE =
  /(?:ignore|disregard|forget|reset|override|supersede|skip)\b.*?\b(?:previous|prior|above|earlier|current|all|your|the)\b.*?\b(?:instruction|prompt|rule|guideline|directive|context|system)s?\b|\b(?:system|assistant|developer)\s*:|\byou are (?:now|a|an)\b|\b(?:new|updated|revised) instructions?\b|\bfrom now on\b|\bpretend (?:to|that|you)\b|\bact as\b|\bdisregard\b/gi;

export function sanitizeUntrusted(s: string, max = 600): string {
  const folded = (s ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF\u2060\u00AD]/g, "") // zero-width / soft-hyphen / word-joiner
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ") // control chars (keep tab/newline before collapse)
    .replace(/[\u0400-\u04FF\u0370-\u03FF]/g, (ch) => CONFUSABLES[ch] ?? ch) // fold Cyrillic/Greek homoglyphs
    .replace(/\s+/g, " ") // collapse all whitespace incl. newlines -> defeats multi-line splits
    .replace(/`{3,}/g, "``"); // neutralize code fences that could break a delimiter
  return folded.replace(INJECTION_RE, "[redacted-injection]").slice(0, max).trim();
}
