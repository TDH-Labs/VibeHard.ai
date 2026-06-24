# Spec: parallel codegen (backlog #4)

## Goal
Generate the independent workstreams WITHIN each dependency tier concurrently
(bounded), instead of one-at-a-time. Same-tier workstreams have no dependency on
each other (buildOrder guarantees every dependency sits in an earlier tier), so
running them in parallel cuts wall-clock without changing the output. Tiers stay
strictly sequential (tier N+1 sees tier N's files via `built`).

## Why it's safe
- `buildOrder(arch)` returns tiers where each workstream's `dependsOn` is fully
  satisfied by earlier tiers. Within a tier there are no edges → independent.
- Each workstream owns a disjoint file set and runs its own engine session
  writing whole files (Bun.write is atomic per call) into the shared target.
- `built` (the names a brief is told already exist) is the prior-tiers snapshot —
  identical for every workstream in the tier — so the briefs are unchanged from
  sequential mode.

## Acceptance criteria
1. Within a tier, workstreams run concurrently, capped at
   `DRYDOCK_CODEGEN_CONCURRENCY` (default 4), never more.
2. Tiers remain sequential; `built` accumulates a full tier before the next.
3. The produced file set is the SAME as sequential codegen (no behavior change,
   just faster) — verified by the existing build/gate path staying green.
4. If ANY workstream in a tier fails, the build fails (same as sequential) — a
   failure in one doesn't get swallowed by a sibling's success.
5. Interleaved progress output stays attributable (each line tagged with its
   workstream).

## Out of scope
- Cross-tier parallelism (tiers are a hard dependency barrier).
- Streaming/merging engine events into one ordered log (tagging is enough).
- Per-workstream retry (that's the gate/auto-fix layer's job, post-build).

## Design
- `src/util/pool.ts`: pure `mapPool(items, limit, fn)` — bounded-concurrency map
  that preserves result order and runs every item. The genuinely testable unit.
- `buildFromArchitecture` (src/cli.ts): replace the inner sequential
  `for (ws of tier)` with `mapPool(tier, concurrency, …)`; return false if any
  result is false; push the whole tier to `built` after it completes.
- `streamGeneration`: add an optional `label` that tags its progress lines so
  concurrent workstreams' output is distinguishable.

## Verify
- tsc clean; full suite green.
- Unit (pool.test): mapPool preserves order, never exceeds the limit
  (instrument concurrent count), runs all items, handles limit>items and a
  single item, propagates a thrown fn.

## Eval / live-validate
- Confirm a multi-workstream tier actually runs in parallel and the cap holds
  (the pool test proves the cap deterministically; a focused run shows overlap).
- Equivalence: the build path still produces a gateable app (existing e2e).

## Adversarial review
- Fresh-context review of: same-tier file collisions (two workstreams writing
  one path), error propagation (a failed sibling not masked), `built`
  correctness under concurrency, and the cap actually bounding outbound LLM calls.
