# Spec: iterate / refine loop (backlog #2)

## Goal
After an app is built, let the user request a change in plain language
("add a logout button", "show the invoice total in bold") and have the app
**incrementally regenerated + re-gated**, without re-planning the whole thing
from scratch and without silently breaking a previously-passing build.

`vibehard refine <dir> "<change request>"`

## Why this shape
- **Spec is the source of truth** (§ project principle): the change is folded
  into `.vibehard/spec.json` so the request is durably recorded and the spec
  keeps describing what the app actually is. Code stays a projection.
- **Minimal blast radius:** we do NOT re-run the heavy PRD→SRS→architecture
  plan (the user already found full planning slow). We feed the engine the
  CURRENT app + the change and let it emit ONLY the files that change. Bolt
  overwrites emitted files and leaves the rest — so a one-line ask changes one
  thing, not the whole app.
- **Never leave it worse:** refine checkpoints the tree first (reuse
  `fileCheckpointer`). After regen we re-gate; if the app was GREEN before and
  is RED after (and auto-fix can't recover it), we RESTORE the checkpoint and
  report honestly. A refine that can't keep the gates green is rejected, not
  shipped.

## Acceptance criteria
1. `vibehard refine <dir> "<change>"` exists; errors clearly if `<dir>` has no
   `.vibehard/spec.json` (must `build` first) or the change string is empty.
2. The change is appended to the persisted spec (a `refinements` trail) so it
   survives and informs future refines.
3. Regeneration is incremental: unrelated files are not gratuitously rewritten
   (the engine is told the current app and asked for just the delta).
4. After regen the gate chain re-runs. If blocked, the existing fix→re-gate
   loop is attempted.
5. **Safety invariant:** if gates passed before the refine and cannot be made
   to pass after (incl. auto-fix), the original tree is restored and the
   command reports the refine was rejected. A green build is never left red.
6. Honest report: what changed (files written), gate outcome, and whether the
   refine was accepted or rolled back.

## Out of scope (v1)
- Structural changes that need NEW workstreams/architecture (escalate / re-plan
  is a separate, heavier path).
- Multi-step conversational iteration UI (the web Q&A panel) — CLI first; web
  can call the same engine path later.
- Diff preview / approval before applying (the checkpoint+restore net covers
  the "don't break it" risk for batch mode).

## Design
- `src/refine/refine.ts`: pure-ish orchestrator
  `refine(dir, change, opts)` →
  1. load `.vibehard/spec.json`; if absent → throw a clear error.
  2. `wasGreen = (await gate(dir)).passed` (baseline).
  3. `backup = checkpoint.save(dir)`.
  4. fold change into spec (`appendRefinement`) + persist.
  5. build a refine brief (current file manifest + contents, bounded) and run
     the engine once to emit changed files.
  6. `after = await gate(dir)`; if `!after.passed` → run autofix.
  7. if still `!passed` AND `wasGreen` → `checkpoint.restore(dir, backup)`,
     return `{accepted:false, restored:true, ...}`.
  8. else return `{accepted:true, filesWritten, gate: after, ...}`.
- `appendRefinement(spec, change)`: pure — pushes `{at, change}` onto
  `spec.refinements` (additive; never drops existing features).
- Reuse: `runGate` (src/gate), `fileCheckpointer` (src/refactor), the bolt
  engine session, `autoFix` (src/autofix).
- `src/cli.ts`: `refine` command wires the orchestrator + prints the report.

## Verify
- tsc clean; full suite green.
- Unit: `appendRefinement` is additive + records the change; the refine
  orchestrator (with a FAKE engine + FAKE gate) (a) accepts when post-gate
  passes, (b) restores + rejects when it was green and goes red, (c) errors
  with no spec. No live LLM in unit tests.

## Eval / live-validate
- On a real previously-built app dir: run a benign refine ("add a footer with
  the current year"), confirm it applies, stays green, and only touches a few
  files. Then a refine that would break the gate (if reproducible) confirms the
  restore path. Report findings.

## Adversarial review
- Fresh-context review of the restore invariant (can a partial regen + failed
  restore corrupt the tree?), the spec fold (can a change drop data?), and the
  "incremental" claim (does the brief actually constrain the engine, or could
  it rewrite everything?).
