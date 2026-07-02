# VibeHard.ai — Locked Design System & Build Manifest
_Phase 0 artifact. Every later phase is reviewed against this document. Drift gets fixed, not carried._

## 1. Locked decisions

**Accent — LASER AMBER `#FFB000`.**
Amber is the color of inspection machinery: hold lights, machine-status LEDs, phosphor
terminals. This brand's story is an inspection line that refuses to release flawed code,
so the accent should read as instrumentation passing judgment — not "AI-startup neon."
It also breaks completely from the previous site's teal/green (#2bd29b) family, which is
explicitly banned. Toxic Green was disqualified as same-family-as-previous; Cyber Pink
reads nightlife, not machinery.

- Tint ladder: `#FFB000` (accent), `#FFD98A` (small-text tint), `#7A5200` (dim/idle LED).
- Semantic red for BLOCK verdicts only: `#FF4D42`.

**Typography.**
- Display/editorial: **Archivo** (variable: `wdth` 62–125, `wght` 100–900). Headers run
  expanded widths at 850–900 weight — industrial editorial, not friendly-startup grotesque.
- System/data: **JetBrains Mono** for every metric, label, log line, gate name, and
  terminal stream. If it's the machine talking, it's mono. No third family.

**Tech stack — one, matching what exists.**
A single static `web/landing/index.html` (inline CSS + vanilla JS, zero build step,
zero dependencies), served by the existing Bun server (`web/server.ts` → `serveStatic`).
The site this page sits alongside (`app.html`) is the same architecture. No framework
is introduced.

**Glass/brutalism resolution rule.**
Glass panels are rectilinear: `border-radius: 0`, the same `1px solid #2D2D2D` hard frame
as every other container. `backdrop-filter: blur()` + translucency is the ONLY softness,
and it applies to backdrop content behind the panel — never to the frame. No panel gets
a soft drop shadow. Anywhere, ever.

**Canvas & geometry.**
`#000000` base, `#0D0D0E` matte carbon panels, 1px `#2D2D2D` grid lines. Animated SVG
noise/grain overlay (feTurbulence data-URI, stepped background-position keyframes,
opacity ≈ 0.05, disabled under `prefers-reduced-motion`). Containers butt-join like
milled hardware — shared borders, no gaps, no rounding.

**CTA — "ENGAGE IGNITION" is real, not theater. The free sample IS the threshold.**
Anonymous visitors prompt immediately: the hero console POSTs to `/api/spec-preview`
(unauthenticated; same-origin + 600-char cap + 3/hour/IP + global daily ceiling), which
runs ONE pass of the real `llmIntake` and grades it with deterministic `reviewSpec`.
The drafted spec sheet renders in the glass — a real deliverable, before any account.
Continuing to an actual build is the gate: the idea is stashed in
`localStorage["vh.idea"]` and `/app` (live Clerk signup) prefills the build prompt
from it after auth. Sign-in also remains directly available in the nav at all times.
Access model: **immediate account creation** (Clerk is live in production). No waitlist.

**Pricing — shown, real numbers.**
$0 / $29 / $99 per month with the true quotas from `src/platform/plans.ts`:
2 / 5 / 20 gated builds per day, 1 / 5 / 25 projects. No invented metrics.

**Gate count — corrected from the brief.**
The brief says 9 gates / 3×3. The registry (`src/gate/index.ts` `GATES`) runs **eleven**:
sast, secrets, depvuln, rls, migrate, rls-enforce, compliance, pii, prod-readiness,
verify, completeness. This site does not lie about the count. The matrix is **4×3 =
12 cells: the 11 real gates + THE SENTINEL** (the HMAC deploy ratchet that is the
matrix's only exit). Deviation documented here; accuracy outranks symmetry.

**Anchor contract (must survive).**
`app.html` links to `/#gates` and `/#trust`. Section 3 carries `id="gates"`; the
receipts strip in Section 4 carries `id="trust"`. `#pricing` added for nav/footer.

## 2. The one rule that governs all copy
Craftsmanship/artisanal language belongs ONLY to the end product (Section 4), earned
because of what the pipeline did to it. The gates themselves are never craftsmen:
they are adversarial, deterministic, cyclical, unforgiving machinery. Section 3 is
written with zero craft vocabulary. Section 1 = human intent meets heavy machinery.
Section 2 = structural engineering documentation, not artistry.

## 3. Build manifest (order + dependencies)
| Phase | Builds | Depends on |
|---|---|---|
| 1 | Tokens, grain, nav, footer, **S1 Ignition** (hero grid, smoked-glass console over live gate-log stream, CTA handoff incl. `app.html` prefill) | Phase 0 |
| 2 | **S2 The Uncompromising Spec** — editorial left rail + sticky self-populating mono blueprint (spec.json → PRD → architecture.json → data model), scroll-driven | P1 scaffold/observer utils |
| 3 | **S3 The Gate Matrix** (`#gates`) — 12-cell 4×3 grid, keyboard-navigable (arrows + tab), focus-driven readout panel, THE LOOP band (gate→fix→re-gate, bounded, anti-tamper, escalation) | P1 tokens |
| 4 | **S4 The Proof Engine** — receipts dashboard, `#trust` strip, pricing block (`#pricing`), final drift review vs this doc, typecheck+tests, commit, deploy | P1–P3 |

Per-phase exit review: rectilinear glass only · single accent · mono = machine voice ·
no craft language in S3 · anchors intact · mobile breakpoints · keyboard + reduced-motion.

## 4. Accessibility note
`#FFB000` on `#000000` ≈ **11.6:1** and on `#0D0D0E` ≈ **11.0:1** — passes WCAG AA (and
AAA) for text at all sizes. Fallback: amber text below 14px, or on raised `#161618`
surfaces, uses the `#FFD98A` tint (≈ 13:1 on black) for comfort margin. BLOCK-red
`#FF4D42` on `#0D0D0E` ≈ 5.4:1 — AA for the ≥14px mono labels it's used on. All
interactive elements (prompt input, CTA, 12 matrix cells) are focusable with visible
`:focus-visible` states; matrix supports arrow-key traversal; all motion honors
`prefers-reduced-motion`.
