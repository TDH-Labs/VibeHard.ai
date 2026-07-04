# VibeHard — positioning & messaging (binding)

> The marketing voice, grounded in competitor shopping (2026-06-22), not invented. Pairs with
> `docs/design-language.md` (the in-app voice) and binds to §16 (positioning) + the §16 honest-
> copy rule. Disagree → change it here first. The homepage copy should fall out of this doc;
> if a line can't be traced to a choice here, it's freelancing.

## What the category actually sounds like (the evidence)
Two competitor sets, and they speak opposite languages — leaving a gap in the middle.

**Set A — the vibe-coding builders (Lovable, Base44, Bolt, Replit, v0).** Near-identical:
- Heroes: "What will you build?" (Replit, Bolt, v0 all do the question), "Build something Lovable,"
  "Turn your ideas into apps."
- Saturated words: *build, create, ship, idea/vision, AI/agent, minutes/instantly/seconds, no code,
  superpowers, limitless, powerful.* **"Build" is worn out — everyone leans on it.**
- One emphasis: **speed + ease + magic** ("speed of thought," "watch it come to life," "hours not
  months," "one click").
- Security is **absent or buried** (Bolt's "enterprise-grade," Replit's enterprise tier — that's it).
- They are the villain we name, and they say it cheerfully.

**Set B — the compliance builders (Blaze, Knack, Specode).** The opposite register:
- Lead with **"HIPAA-compliant," BAAs, encryption, "regulated industries."**
- Serious, badge-led, clunky. Specode even says "control that doesn't vanish once you hit deploy" —
  someone's already near our gate thesis.
- They lean on a **compliance badge** — which §16 forbids us, and which buyers increasingly distrust
  ("'HIPAA ready' is marketing shorthand for 'has some controls'").

> **2026-07-03 revision:** the human-review layer is out of the product story (Adam's direction —
> failing gates rely on the bounded fix loop and the HOLD). The moat language throughout this doc
> now reflects that; do not resurrect "a real engineer reviews it" claims.

## The gap we own (positioning statement)
> For **non-technical professionals who handle data people trust them with** — therapists,
> bookkeepers, clinics, small law practices — **VibeHard** is the app builder that **checks every app
> the way a security team would before it ships — and holds anything that can't pass, instead of
> shipping it.** Unlike the vibe-coding builders (who ship straight to deploy and leak), and unlike the
> compliance builders (who hide behind a badge), VibeHard is **as easy as the magic ones, as careful as
> the serious ones — and honest enough to show its work instead of faking a badge.**

The one-line internal frame: **VibeHard is the grown-up in the room of vibe-coding.** Everyone else sells
magic; we're the one who says "magic's great — but someone should make sure it handles real people's
data before it goes live."

## Messaging matrix
| | Set A (Lovable/Bolt…) | Set B (Blaze/Knack…) | **VibeHard** |
|---|---|---|---|
| Hero promise | "Build anything, fast" | "HIPAA-compliant, no code" | **"Safe to ship — proven, not promised"** |
| Emotion sold | Excitement / magic | Compliance / cover | **Relief, then pride** |
| Tone | Breezy, hype | Corporate, badge-led | **Calm, honest, craft** |
| On security | Buried / absent | The whole pitch (a badge) | **Shown in plain language — what we check, no badge** |
| On failure | Ships anyway | Ships behind the badge | **A build that can't pass is held, never shipped (the moat)** |
| Honesty | "It just works!" | "Compliant" (often hollow) | **"Here's exactly what we checked"** |

## Words we own / words we ban
**Own (lead with these):** *safe to ship · before it goes live · the data your clients trust you with ·
checked · stays theirs · held, never shipped · honest · we show our work · won't leak.*
**Ban (category wallpaper or §16 violations):**
- *build / create* as the **hero** word (saturated across all of Set A — use only in support copy).
- *no-code* (Set B's worn word; also faintly diminishing).
- *superpowers / limitless / speed of thought* (Set A hype — wrong register for trust).
- **§16 HARD BANS (legal + binding):** "HIPAA-compliant," "SOC 2 compliant," "compliant," "unhackable,"
  "100% secure," "bulletproof," "bank-grade," "0 breaches." We say what is **true by construction**:
  *"we check for X," "the checks a security engineer runs," "every app, security-checked."*

## The voice
- **Marketing leads fear-first, then empowerment** (the in-app voice is pure empowerment — see design
  doc — because trust is already earned). Order on the site: **name the fear → name the villain →
  relieve it → then make them feel powerful.** The buyer's dominant pre-purchase emotion is *"I'd love
  an app but I'm scared of doing something dumb with my clients' data."* Speak to that first.
- **Craft register, gravitas not confetti** (inherits the design-language rule). Calm confidence, not
  hype. We're the mature one.
- **Radical transparency as the differentiator.** The category overclaims; we under-claim and *show the
  work.* That contrarian honesty is the trust play — it lands *because* everyone else fakes the badge.

## Homepage message hierarchy (the spine, not final copy)
1. **Hero** — the promise: ease + safety fused, in the trust register. Candidates (pick/test):
   - "The app your business needs — without risking your clients' data."
   - "AI builds your app. We make sure it's safe to ship."
   - "Finally, an app builder that treats your clients' data like it matters."
   - CTA: **"Describe your app →"** (empowerment starts at the button — never "Sign up").
2. **The villain** — name the enemy: "Most AI builders will happily ship you an app that leaks. They
   optimize for *wow, it works* — not *my client list won't end up on the internet.*"
3. **How it works** — the three beats (describe → we check it like a security team → it's live), with the
   hold branch shown, not hidden.
4. **The differentiator** — the hold + the honesty: "When something can't pass the checks, the build
   holds — you see the exact piece that failed, in plain English, and nothing unsafe goes live. And
   we'll never fake a compliance badge — we'll show you precisely what we checked."
5. **Who it's for** — segment-specific, honest: "For the people who can't afford to get this wrong."
6. **Proof / trust** — the Trust center (what we check, how data is handled, subprocessors). For this
   segment this is a *conversion* page, not an afterthought — and it must be honest to be legal.

## Hero A/B test set + smoke test (the cheapest demand validation)
Run the hero choice as a **smoke test**, not a guess: 2–3 one-page landing sites, same promise,
different hero; a few hundred dollars of paid traffic (Reddit/LinkedIn/Google); measure
"Describe your app" / waitlist conversion. This validates **copy AND demand in one shot** —
demand being the #1 unknown (does the segment want this). Low traffic = directional only; needs
enough signups for signal. Do this **before** building the front door.

Candidates, grouped by beachhead (the real fork — who walks in first):

**Beachhead 1 — the burned vibe-coder (prosumer; already tried Lovable/Bolt, got a toy):**
- A — "Vibe coding builds toys. Vibe engineering builds real software." *(coins the category; ownable; needs the buyer to know "vibe coding.")*
- B — "Stop vibe coding. Start engineering real software." *(imperative stop/start; most self-explanatory; slight risk it implies effort vs "vibe engineering" = easy+real.)*
- C — "Build like you've got an engineering team — because now you do." *(moat-led; the one line that works for BOTH beachheads.)*

**Beachhead 2 — the cold sensitive-data pro (therapist/bookkeeper; never heard "vibe coding"):**
- D — "Your clients trust you with their data. Your software should earn it too." *(fear→relief; uncopyable; smaller/colder but higher-value market.)*

Shared across all: CTA "Describe your app →"; the honest line "No fake compliance badges — we
show you exactly what we check." Note the **audience fork**: A/B/C lean prosumer, D leans cold-
non-technical. Cleanest play if both test well — lead the homepage with the winning prosumer
hero, run D on the vertical pages ("For therapists") where that buyer actually searches. One
brand, two doors.

## What still needs to be TRUE before it ships
Marketing writes checks the product cashes (§16). Before these lines go live: any number ("every app
checked") must be real; the hold behavior described must match what the gates actually do; the Trust center
must describe the *actual* data handling, not aspirational. A single overclaimed line here isn't a
growth tactic — it's the thing that gets us sued by the exact customers we're courting.
