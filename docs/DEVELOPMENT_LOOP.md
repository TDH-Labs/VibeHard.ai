# Drydock — development loop (process of record)

How we build Drydock: the same discipline Drydock imposes on the apps it builds —
**the agent proposes; deterministic checks + live runs dispose; the human owns judgment.**
This is §11 ("LLM proposes, deterministic disposes") and §16 (adaptive rigor) turned on our
own development. Grounded in current best practice (Anthropic *Building Effective Agents* +
Claude Code; Karpathy's autonomy slider; Harper Reed's spec→plan→execute; Willison "if you
haven't seen it run, it isn't working"; Hamel/Shankar eval-driven dev; GitHub Spec Kit /
Grove "spec is the source of truth"; Cursor/Copilot small-diff + plan-first).

## Principles
- **Spec is the source of truth; code is a regenerable projection of it.** Every non-trivial
  item gets a short, durable spec — the thing we re-load after a context clear and the thing
  the adversarial reviewer checks against.
- **Autonomy is a slider, set per item by `complexity × blast-radius`** — not a binary.
  Anything touching auth, payments, RLS / tenant-isolation, data migration, or anything
  irreversible drops to **low autonomy** (mandatory design gate, smaller slices, adversarial
  review) *even when the change is small*.
- **Never commit red.** Typecheck + the full suite green is the floor.
- **If you haven't run it for real, it isn't done.** Live-validation is a DoD item, not a nicety.
- **Small, single-concern diffs.** A sprawling diff is unauditable — doubly so under batch review.
- **Honest reporting, no overclaiming** (§16). Evidence, not assertion. State the limits.

## The two first-class artifacts
1. **`spec.md` (or a spec block) per item** — durable intent + acceptance criteria. Re-loadable
   into a fresh context; the reference the adversarial reviewer judges against.
2. **Evals for LLM-driven behavior** — assertion-based checks on real outputs, grown from
   error-analysis of real traces, checked in, run in VERIFY. *In this codebase the deterministic
   disposers (`reviewPrd`, `reviewSrs`, `reviewArchitecture`, the gates) ARE this eval layer;
   extend them when a new LLM-driven behavior ships.* Skip for purely deterministic logic —
   the unit suite is the right tool there.

## OUTER loop (rollout)
1. One prioritized backlog → pick the top agent-buildable item.
2. **Set the autonomy level** = complexity × blast-radius (see slider above).
3. Run the INNER loop.
4. Checkpoint: demo + honest report.
5. **`/clear` (or compact) between items** — carry forward only the spec, the memory file
   (`MEMORY.md` / the project memory), and open learnings. Context is a managed resource.
6. Re-prioritize from learnings; repeat until the backlog is empty.
7. **Batch-run stop-conditions** (when running unattended): abort the item and flag for the
   human if — the suite can't go green in **N=3** attempts, an adversarial review finds a real
   correctness gap **twice** on the same item, a live-validate reveals data-loss / secret-leak /
   irreversible risk, or a token/time budget is hit. Stop > guess.

## INNER loop (per feature)
1. **FRAME** — scope + acceptance criteria + the autonomy/rigor call. **Write it down** (a
   `spec.md` for the item, or a durable spec block) — the source of truth, not a throwaway.
2. **DESIGN** *(heavy and/or high-risk only)* — the smallest vertical slice + the seam;
   pure-core-separated-from-I/O so it's testable. **Bound the diff: one concern; split if it
   won't fit a reviewable change.**
3. **BUILD** behind the seam.
4. **VERIFY (deterministic)** — typecheck + unit tests with fakes + the **full suite green**.
5. **EVAL** *(any LLM-driven / non-deterministic behavior)* — run it on representative inputs;
   error-analyze failures; capture each new failure mode as a checked-in check (extend a
   `reviewX` disposer or add a fixture test). Use an LLM-judge only if its agreement with hand
   labels is measured. Skip for deterministic items.
6. **LIVE-VALIDATE** — run it for real (real LLM call / build / curl). The whole reason: unit
   tests miss integration bugs (proven repeatedly — GitHub eventual-consistency, SRS truncation,
   transitive CVEs).
7. **ADVERSARIAL REVIEW (fresh context)** *(heavy/high-risk)* — a reviewer subagent checks the
   diff against the spec: "report only gaps that affect correctness, not style." The cheap
   substitute for the human we're batching past.
8. **HONEST REPORT** — works / broke / limits, evidence attached.
9. **COMMIT to `main`** (trunk-based) in a small, single-concern diff + **update the memory**
   (decisions, open issues — the rehydration anchor after a clear). Commit trailer:
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Definition of Done
typecheck clean · full suite green · **evals green** (LLM-driven behavior) · **live-validated** ·
**adversarially reviewed** (heavy/high-risk) · committed in a small diff · honestly reported with
its limits · **memory updated** · **spec written/updated**.

## Human gates
- **Design gate** — heavy AND/OR high-risk items, before building.
- **Ship gate** — after validation.
- **Adaptive rigor** — light/low-risk items skip the spec-write / Design / Eval / adversarial
  pass; high-risk items **cannot** skip the Design gate even when small.

## Roles
- **Agent:** frame → design → build → verify → eval → live-validate → adversarial-review →
  report → commit. Proposes; tests + live runs dispose on correctness.
- **Human (operator):** owns direction + the two gates, weighs judgment/risk calls, and supplies
  what only a human can — API keys, OAuth apps, DNS, a Slack bot token, **and the reviewers for
  the escalation moat.**

## Current backlog (this loop processes it in order)
1. **Grill-me** — interactive adaptive intake (asks the user clarifying questions before build).
2. **Iterate / refine** — change-and-rebuild loop (turns one-shot into a tool).
3. **Reviewer moat** — SWE-contractor signup + scoped-slice review flow + Slack *(part people:
   operator recruits 1–3 reviewers; agent builds the rest).*
4. **Parallel codegen** — generate independent workstreams concurrently (`buildOrder` tiers).
5. **Billing · build sandbox · public hosting** — for moving past solo testing *(part external:
   Stripe products, a host, DNS, OAuth apps).*
