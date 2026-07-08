# VibeHard.ai — "Gallery" Design System (v2)

_v2 manifest, 2026-07-08. Replaces "Midnight Studio & Hardware" (amber-on-black industrial),
retired at Adam's direction: the dark system read as cluttered and hard to navigate. The
reference target is cartage.ai — clean, whitespace-forward, editorial. Every page is reviewed
against this document. Drift gets fixed, not carried._

## 1. Tokens (single source: `site.css`)

**Canvas (light, warm).**
- `--bg: #F1EFEC` — warm off-white page base
- `--surface: #FFFFFF` — cards and panels
- `--ink: #25211C` — warm near-black, all body text and headlines
- `--ink-2: #666460` — secondary text
- `--ink-3: #92908D` — tertiary/labels
- `--line: #D3D3D2` — hairline borders

**Accent — Laser Amber survives the flip.**
- `--amber: #FFB000` — THE brand accent. **Fills only on light canvas**: primary CTA
  background (with `--ink` text ≈ 8.8:1, AAA), highlight chips, underline accents,
  small marks. **Never as text color on the light canvas** (1.6:1 — fails).
- `--amber-text: #7A5200` — darkened amber for the rare amber-toned text/link
  (≈ 6:1 on `--bg`, AA).
- `--amber-soft: #FFF3D1` — cream tint for chip/panel backgrounds.
- `--block-red: #B3261E` — BLOCK verdicts only (darkened for light canvas; the old
  `#FF4D42` fails contrast on white). Red is never decorative.

**Geometry.**
- Radius: `--r-s: 8px` (buttons, chips), `--r-m: 12px` (cards), `--r-l: 20px` (hero panels).
- Borders: `1px solid var(--line)`. Shadows: at most one soft ambient
  (`0 1px 2px rgb(37 33 28 / 5%), 0 8px 24px rgb(37 33 28 / 6%)`) on raised cards. No
  glass, no grain, no butt-joined panels, no hard black frames — whitespace does the work.

**Type (three families, no fourth).**
- Display: **Instrument Serif** (400, + italic) — headlines only, editorial serif,
  tight leading (1.05–1.15), sizes clamp 2.4rem → 4.5rem for h1.
- Body/UI: **Inter** (400/500/600) — everything that isn't a headline or machine text.
- Machine: **JetBrains Mono** (400/500) — gate names, metrics, eyebrow labels, log/terminal
  text. If it's the machine talking, it's mono. Mono eyebrows are 12px, uppercase,
  letter-spaced, `--ink-3`.

## 2. Density rules (the anti-clutter contract)

- **One idea per section.** A section = one headline, 1–3 short sentences, at most one
  visual element. If a section needs a second headline, it's two sections or it's a page.
- Homepage: **≤ 5 content sections** between nav and footer, **≤ 3 CTAs** above the footer,
  target ≤ 450 lines total.
- Max content width 1080px; text measure ≤ 65ch; section vertical padding ≥ 96px desktop.
- Interactive theater is retired: no live log streams, no scroll-driven blueprints, no
  animated matrices on marketing pages. The one interactive element that stays is the hero
  spec console — it is the product's real free sample, not decoration.
- **Visuals are product-true or mechanism-true, never decorative.** Two kinds are allowed:
  a mockup mirroring a real product surface (real gate names, the dashboard's real labels
  and states — nothing invented), or a diagram of a real mechanism (the two-tenant attack,
  the artifact chain). One visual per section, same budget as any other element. No stock
  imagery, no abstract illustration.
- **Motion only where it depicts the mechanism** — the inspection sequence advancing, a
  running gate's spinner. It pauses off-viewport, loops gently, and every animated element
  has a meaningful reduced-motion fallback (the *finished* state, not a freeze mid-run).
  No entrance animations, no parallax, no grain. Current instances: the homepage hero
  demo (the example sentence types, the build narrates, the finished client portal fades
  in — labeled "an example build"), the homepage inspection line (chips light in registry
  order, sentinel signs), the trust page verdict board's running-gate spinner.
- **Speak the reader's language per page.** The homepage uses the dashboard's human gate
  labels ("Code security", "Tenant isolation attack"); the mono registry ids
  (sast, rls-enforce, …) live on the trust page, where the technical reader is.
- Example-build content (the demo's "Riverside Therapy" portal) is always labeled as an
  example and depicts product output — never a named customer, quote, or metric.
- Depth lives on interior pages. The homepage links to it; it does not compress it.

## 3. Voice

Short declarative sentences. Calm confidence. Plain words. The "inspection machinery"
register is retired with the dark system — no drama, no industrial theater, no craft
vocabulary anywhere. State what the thing does; let specificity carry the weight. Read
cartage.ai for the register: sparse, direct, human.

All of `COPY.md` still binds: per-page brief before writing, every claim traced
(`docs/positioning.md`, `docs/pricing.md`, `src/gate/index.ts`), the AI-tell audit before
any page ships, full end-to-end re-read.

## 4. Standing facts (verified 2026-07-08 — re-verify before editing claims)

- **Twelve gates + THE SENTINEL**: sast, secrets, depvuln, rls, migrate, rls-enforce,
  compliance, pii, prod-readiness, proptest, verify, completeness (`src/gate/index.ts`),
  plus the HMAC deploy ratchet. Never rounded. (proptest — PRD acceptance criteria run
  as property tests — landed with EPIC #53; older copy saying "eleven" is stale.)
- **Pricing**: $0 / $39 / $199 monthly; quotas 2/5/20 gated builds per day, 1/5/25 projects
  (`src/platform/plans.ts`).
- **Hero console is real**: POST `/api/spec-preview`, unauthenticated, **4000-char cap**
  (raised from 600 on 2026-07-06), 3/hour/IP. Idea stashes to `localStorage["vh.idea"]`;
  `/app` prefills from it after Clerk signup. This flow must survive any redesign.
- **Anchor contract**: `id="gates"` and `id="trust"` exist on the homepage (app.html links
  to `/#gates`, `/#trust`); `#pricing` for nav/footer.
- **No human-review claims** in marketing or product UI (removed 2026-07-03 at Adam's
  direction) — the bounded fix loop and the HOLD are the story.
- Never "HIPAA/SOC 2 compliant/certified" — "helps toward, never certifies."

## 5. Architecture

One shared stylesheet — `web/landing/site.css` — holds tokens, reset, nav, footer,
buttons, cards, type scale, section scaffolding. Pages carry only page-specific styles
in a small inline `<style>`. Still zero build step, vanilla JS only, Google Fonts CDN
(Instrument Serif, Inter, JetBrains Mono), served generically by `web/server.ts`.

## 6. Accessibility

- `--ink` on `--bg` ≈ 13:1 (AAA). `--ink` on `--amber` ≈ 8.8:1 (AAA) — amber buttons
  always carry ink text, never white. `--amber-text` on `--bg` ≈ 6:1 (AA).
- Amber is never a text color at any size on light surfaces; use `--amber-text`.
- `:focus-visible` on all interactive elements (2px `--ink` outline, 2px offset).
- All motion honors `prefers-reduced-motion`. No autoplaying animation on the canvas.
- Keyboard: nav, console, and all links tabbable in DOM order.
