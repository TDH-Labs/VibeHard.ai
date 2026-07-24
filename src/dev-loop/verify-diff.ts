/**
 * The dev loop's own second-pass adversary (not the product's generated-app pipeline —
 * this reviews changes TO VibeHard's own source, made by scripts/loop-run.sh's `finish`
 * step). `verify()` in that script already gates on tsc+test — necessary, not sufficient:
 * a diff can be green and still be the wrong fix (patches a symptom, drifts off what the
 * commit message claims, quietly loosens an assertion instead of fixing what it tests).
 * This adds an independent, skeptical read of the actual diff against the actual claim,
 * one gate later than `verify()`, one gate before `git commit`.
 *
 * Same seam shape as spec-review/review.ts's `Adversary`: `judgeDiff` is pure and takes an
 * injected adversary (fake-testable, no network in the unit tests); `liveDiffAdversary`
 * is the real LLM-backed implementation. Unlike reviewFrontHalf's adversary, THIS one's
 * verdict has real teeth (reject → the loop reverts) — safe to let it, because reverting
 * unshipped local WIP is cheap and fully recoverable (scripts/loop-run.sh's own design
 * goal: "the worst case is a wasted run"), nothing like reviewFrontHalf's front-half plan
 * where an LLM opinion blocking a live build was judged too risky to auto-enforce.
 *
 * Fails OPEN on a call failure (network hiccup, unparseable response) — mirrors
 * reviewFrontHalf's "adversary-unavailable" handling exactly: a transient provider error
 * must never revert work that already passed typecheck+test. It only reverts on an
 * actual considered verdict of verified:false.
 */
import { execSync } from "node:child_process";
import { defaultModelFactory, generateTextResilient, type ModelFactory } from "../engine/bolt/driver.ts";
import { configForStage } from "../config/models.ts";
import { tryExtractJsonObject } from "../spec/coerce.ts";

export interface DiffVerdict {
  verified: boolean;
  notes: string;
}

export type DiffAdversary = (input: { commitMessage: string; diff: string }) => Promise<DiffVerdict>;

/** Pure: nothing staged never needs a reviewer; a reviewer that throws fails open. */
export async function judgeDiff(input: { commitMessage: string; diff: string }, adversary: DiffAdversary): Promise<DiffVerdict> {
  if (!input.diff.trim()) return { verified: true, notes: "nothing staged — nothing to review." };
  try {
    return await adversary(input);
  } catch (e) {
    return { verified: true, notes: `review unavailable, proceeding: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const SYSTEM = `You are an independent, skeptical second reviewer for VibeHard's OWN dev-loop commits — not the product's generated-app pipeline. You did not write this diff. Your only job: does the diff actually, minimally, correctly do what the commit message claims — nothing more, nothing less?

Reject if: the diff doesn't match what the message claims; it's broader than the message implies (unrelated files, scope creep); it silences or weakens a test/check instead of fixing the underlying problem (a loosened assertion, a skipped/deleted test, a widened tolerance with no stated reason); or it introduces an obvious correctness or security regression the message doesn't mention.

Do NOT reject for style preferences, an implementation you'd have chosen differently, or missing test coverage the message never claimed to add. A green typecheck+test run already happened — you are not re-running tests, you are judging the message against the reality of the diff.

Return ONLY a JSON object, no prose, no markdown fence: {"verified": boolean, "notes": string} — notes: 1-3 sentences, specific to this diff.`;

/** The real LLM-backed adversary. Same "review" stage as the front-half's adversarial pass
 *  (config/models.ts: the strongest reasoning tier — "the one check designed to catch a bad
 *  plan before it's built" — never economize here, and this is that same job, one repo over). */
export function liveDiffAdversary(opts: { modelFactory?: ModelFactory } = {}): DiffAdversary {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config = configForStage("review");
  return async ({ commitMessage, diff }) => {
    const { text } = await generateTextResilient({
      model: modelFactory(config),
      system: SYSTEM,
      prompt: `Commit message (what this diff claims to do):\n${commitMessage}\n\nStaged diff:\n${diff.slice(0, 60_000)}`,
      // THE BUG THIS CLOSES (found live testing this very file): 500 was nowhere near enough —
      // "review" maps to the strongest REASONING tier (config/models.ts), and reasoning tokens
      // eat into this same budget before any output text is emitted, so the JSON verdict got
      // truncated mid-string and silently failed open on every call. Same class of bug as the
      // drydock reasoning-model lesson: too-small maxOutputTokens → silent empty/truncated text.
      maxOutputTokens: 4000,
    });
    const parsed = tryExtractJsonObject(text) as { verified?: unknown; notes?: unknown } | null;
    if (!parsed || typeof parsed.verified !== "boolean") {
      throw new Error(`reviewer returned an unparseable verdict: ${text.slice(0, 200)}`);
    }
    return { verified: parsed.verified, notes: typeof parsed.notes === "string" ? parsed.notes : "" };
  };
}

if (import.meta.main) {
  const commitMessage = process.argv[2];
  if (!commitMessage) {
    console.error('usage: bun src/dev-loop/verify-diff.ts "<commit message>"');
    process.exit(2);
  }
  const diff = execSync("git diff --cached", { maxBuffer: 20_000_000, cwd: process.cwd() }).toString();
  const verdict = await judgeDiff({ commitMessage, diff }, liveDiffAdversary());
  console.log(`${verdict.verified ? "VERIFIED" : "REJECTED"}: ${verdict.notes}`);
  process.exit(verdict.verified ? 0 : 1);
}
