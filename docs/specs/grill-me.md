# Spec: grill-me (interactive adaptive intake)

**Backlog #1 · autonomy: medium complexity × low blast-radius** (pre-build, reversible).

## Goal
After the user's initial prompt, the system asks a few **targeted clarifying questions** to
fill the gaps a builder needs, the user answers (or skips), and the answers are folded into the
build so the spec is sharper and fewer apps get built wrong or held. Original vision §22/§16
("adaptive intake"); the operator flagged it as always-intended.

## Acceptance criteria
1. An engine function generates **0–5 concise, app-specific** clarifying questions from a prompt
   (LLM proposes; deterministic disposes — coerced to ≤5 non-empty trimmed strings).
2. Questions are **specific**, not generic — e.g. for a bookkeeping portal: *"Should clients be
   able to pay invoices in the portal, or only view them?"* — not *"What features do you want?"*
3. **Adaptive:** a clear/trivial prompt yields **few or no** questions (don't grill a converter — §16).
4. Surfaces: a CLI path (`vibehard intake "<prompt>"` prints the questions) **and** a web endpoint
   (`GET /api/intake?prompt=`) returning `{questions: string[]}`.
5. Web flow: **Build it →** first fetches questions → shows them inline → user answers or
   **Skip & build** → answers are folded into the prompt → the normal build proceeds.
6. **Fold (pure):** augmented prompt = original + a `Clarifications:` block of answered Q→A pairs;
   blank answers are dropped; no answers → the original prompt unchanged.
7. Stop/Resume, notifications, the staged tracker — all unaffected (Q&A is pre-build).

## Out of scope (v1)
- Multi-round grilling (one round of questions).
- Pausing *mid-build* for questions (Q&A happens before the build kicks off).

## Design (slice + seam)
- `Questioner` seam = `(prompt, config) => Promise<string[]>`; `llmQuestioner()` is the live impl
  (mirrors `llmIntake`) → unit-testable with a fake. + `coerceQuestions(raw)` trust boundary.
- `foldClarifications(prompt, qa)` — pure, unit-testable.
- Server `/api/intake` calls the questioner; frontend renders the Q&A step.

## Verify / Eval / Live-validate
- **Verify:** unit tests — `coerceQuestions` (cap 5, drop junk), `foldClarifications` (fold + skip
  blanks + empty passthrough); tsc; full suite green.
- **Eval (LLM-driven):** run `intakeQuestions` on 3 representative prompts — a bookkeeping portal
  (expect specific questions on payments/roles/retention), a therapy portal, and a trivial
  unit-converter (expect 0–1 questions). Questions must be specific + non-redundant.
- **Live-validate:** real LLM call end-to-end via the endpoint; then a real build using folded
  answers produces a spec that reflects them.
- **Adversarial review:** fresh-context subagent — are the questions actually useful, is the fold
  correct, any injection risk from folding user answers into the build prompt?
