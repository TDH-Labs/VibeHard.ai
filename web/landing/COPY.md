# VibeHard — Copywriting Criteria

_Companion to DESIGN.md (the visual system). This is the process every customer-facing page and
product string goes through — the same discipline that produced the homepage. Copy that skips it
gets rewritten, not shipped._

## Binding sources

- **`docs/positioning.md`** — the voice. Every line must trace to a choice in that doc; a line
  that can't is freelancing.
- **`docs/pricing.md`** — unit economics. No pricing claim gets written that this doc doesn't back.
- **The code itself** — `src/gate/index.ts` is the gate registry (eleven gates + the sentinel).
  Mechanism claims come from reading the gate, not from memory.

## Per-page brief (written BEFORE any copy)

1. **One reader, one belief.** Who specifically is on this page, and what single thing must they
   believe by the bottom of it to act? Not "explain the gates" — "a bookkeeper who's scared one
   client will see another client's numbers needs to believe that's structurally impossible here,
   not just promised."
2. **Every claim traced to a source.** No stat, mechanism, or number unless it maps to an actual
   gate, a binding doc, or the live product. A number that doesn't exist yet (turnaround time,
   uptime, customer count) gets cut or written as a mechanism — never invented to sound complete.
3. **Ferrari-about-software register.** State what the thing is and does; let specificity carry
   the weight. Never narrate the copy's own tone ("this is where we get serious"); never announce
   a feeling instead of demonstrating it.
4. **Structural arc named up front**, not discovered while writing. Vertical/trust pages:
   fear → mechanism → proof → action. How-it-works: confusion → sequence → confidence.
   Pricing: skepticism → economics → trust in the number.

## The AI-tell audit (mandatory, before a page is called done)

- Reversal tics ("X, not Y" / "isn't X — it's Y") used as a crutch
- Self-narration (describing the copy's own register or effect)
- Triple-parallel / rule-of-three constructions leaned on repeatedly
- Mirrored-antithesis sentence pairs (fine once; a tell when it's the house style)
- **Fabricated specificity** — names, credentials, stats, testimonials with no basis in the
  codebase or docs. (Historical case: an early draft shipped a fictional reviewer, "Alex Chen,
  300+ reviews." The site's own rule — show real work, never claim what isn't earned — makes this
  the worst possible failure. It's a standing check now, not a one-time catch.)
- **Full re-read end to end** before done — not just the section that was touched.

## Standing content rules

- **Gate count is eleven + the sentinel.** Never round it, never say "seven" (a stale draft did).
- **No human-review claims.** The product's answer to a failing gate is the bounded fix loop and
  the HOLD — a held build never ships, the customer sees plain-English findings and can rerun the
  loop or refine the request. Do not write "an engineer has been notified," "routed to a
  reviewer," or any variant that promises a person, in marketing OR product UI (removed
  2026-07-03 at Adam's direction; the loop is the story).
- **Real pricing numbers only**, from `src/platform/plans.ts` and the live Stripe products.
- **Red is for BLOCK verdicts only** (DESIGN.md); pass/held language pairs with amber.
