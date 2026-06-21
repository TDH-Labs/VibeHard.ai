# Drydock — project brief & kickoff

> **Working name:** *Drydock* (a drydock is where a vessel is inspected and made
> seaworthy before it sails — which is exactly what this product does to
> AI-generated apps before they deploy). Placeholder; rename freely. Sits in the
> same nautical family as **Harbor** / **Tugboat**, which it builds on.

This file is self-contained: it assumes the reader (human or agent) has **no prior
context**. Read it top to bottom, then start at **§8 First task**.

---

## 1. One-liner
**Safe vibe coding.** A tool that lets a *non-technical* person describe an app in
plain English and get back a *production-grade, secure* one — because an enforced
engineering gate chain sits between "generated" and "deployed," and an on-demand
human engineer reviews anything the gates can't safely decide.

## 2. The problem (validated, with evidence)
Two facts define the market:

- **Accessibility is solved.** Lovable ($6.6B, 8M users), Bolt, v0, Replit Agent
  already turn a prompt into a working full-stack app for non-technical people.
- **Quality is NOT.** Those apps ship dangerous code, at scale:
  - RedAccess (May 2026): scan of ~380,000 vibe-coded apps → ~5,000 leaking
    sensitive data (medical records, financials, PII).
  - **CVE-2025-48757**: Lovable-generated Supabase projects shipped with
    Row-Level Security off by default → **303 endpoints across 170 sites**
    exposed (10.3% of analyzed apps).
  - 40–62% of AI-generated code carries vulnerabilities; 91.5% of vibe-coded
    apps had at least one hallucination-related flaw (Q1 2026).

**The gap = the product.** Nobody occupies the intersection of *non-technical
accessibility* + *enforced engineering quality*. Every existing tool is either a
developer tool (Cursor, Claude Code, Factory — assume IDE/dev literacy) or an
accessible builder with no real gates (Lovable, Bolt). Drydock is the missing
layer: **hide the gates *from* the operator while enforcing them *for* the operator.**

## 3. What we're building (in layers)
| Layer | Role | Strategy |
|---|---|---|
| **Front door** | Non-technical UX: prompt → app → preview → deploy | **Fork bolt.diy** (MIT, browser, any LLM). NOT an IDE. |
| **Generation engine** | Turns the prompt into code | Pluggable: the Claude **Agent SDK** or bolt.diy's own LLM |
| **Gate chain** ⭐ | verify → security → RLS/compliance → buy-vs-build, between generate & deploy | **Ours — the differentiator.** Proven (see §5). |
| **Skill/room substrate** | Routing + capability gating | **Harbor** (already built, TypeScript) |
| **Escalation marketplace** ⭐ | On-demand engineer reviews the slice a gate flags | **Build — the moat.** No OSS shortcut. |

**Core principle:** the gates sit *between* generate and deploy. bolt.diy ships
straight to deploy today (that's why Lovable apps leak); Drydock inserts the gate
chain into that path. **Nothing deploys until it passes.** When a gate flags a
judgment call it can't auto-resolve, the *single localized slice* is packaged and
routed to an on-demand engineer (the Harbor "rooms" route to the right specialty).

**Build-vs-buy discipline (apply our own buy-vs-build gate to ourselves):** don't
rebuild the front door or the agent loop — graft onto bolt.diy + the SDK. Build
only the two ⭐ rows. That's ~80% assembled, 20% built — and the 20% is the
defensible part.

## 4. Tech stack (decided)
- **Primary language: TypeScript, on Bun.** It's the one language spanning every
  layer we write: Harbor (already TS/Bun), bolt.diy (TS/React), the Agent SDK
  (TS), the marketplace UI (TS/React), and the code the product generates
  (TS/React/Supabase). One language → shared types end-to-end (a `Finding` flows
  gate → escalation packet → review UI) → small team.
- **Security scanners are invoked, not written.** semgrep, gitleaks, trivy are
  best-in-class polyglot binaries — run them as **pinned containers** (Docker/
  OrbStack) and parse their JSON. Never rewrite them.
- **Don't fragment into Python.** No model-training need; the front end must be TS.
  Only shell out to a Python-native scanner if needed.

## 5. The proven core (already built — reuse it)
**Location: `~/dev/gate-proof/`** (bash + containers; a proof, to be ported to TS).
It demonstrates the central claim end-to-end with **real scanners** (semgrep +
gitleaks in pinned OrbStack containers — no fabricated findings):

- A "client-portal" with the exact breach failure modes (live SQL injection,
  hardcoded Stripe secret, the CVE-2025-48757 RLS pattern) → **3 gates blocked,
  deploy refused.** After fixes (parameterized query, secrets→env, real RLS) →
  **all gates passed, deploy allowed, exploit closed.** The gate is a *ratchet*.
- Run against **real public OWASP apps we didn't write** — DVNA and NodeGoat —
  both **BLOCKED** on real findings (Sequelize SQLi, leaked private key,
  hardcoded API keys corroborated by two tools, eval RCE, XSS).
- **Dogfooded on the Harbor source itself** (our own shipped public code): the
  gate found a real latent bug (unescaped interpolation into `RegExp`), we fixed
  it, re-scanned clean, shipped. The gate earns its keep even on careful code.

`gates/scan-target.sh <dir>` runs the gate on any codebase. Read
`~/dev/gate-proof/README.md` for the full results table.

## 6. Existing assets to build on
- **Harbor** — the substrate (rooms, skills, gates, audit, scheduler, session).
  Working repo: `~/dev/harbor-ts`. Public repo: `~/dev/harbor-release` →
  `github.com/TDH-Labs/Harbor` (MIT). npm/import name `harbor-tugboat`, CLI
  `harbor`. Installed live on this machine. TypeScript on Bun, 378 tests.
- **Gate proof** — `~/dev/gate-proof/` (see §5).
- **Roadmap docs** in the Harbor repo: `docs/ROADMAP_reconcile-and-consistency.md`,
  `docs/ROADMAP_harbor-team.md` — design context for the substrate.
- A prior prototype "architect loop" (opencode-swarm; bash + markdown skills +
  JSON config) proved the *pipeline design* (grill → PRD → buy-vs-build → verify
  → security → compliance → refactor → prod-feedback). It is a reference, **not**
  a foundation — it's prompt-defined and provider-fragile. Drydock re-homes that
  pipeline as enforced TS gates.
- **`reference/` (gitignored, local-only) — provenance + the actual prototype
  source.** See `reference/PROVENANCE.md`: it points to the two origin chat
  transcripts (this Claude session + the Pi session) and carries the real
  prototype artifacts (`reference/prototype/`) — the seven pipeline skills
  (`security-gate`, `compliance-posture`, `buy-vs-build`, `methodology-select`,
  `hard-verify-loop`, `refactor-phase`, `prod-feedback` + `scan.sh`), the
  `architect.sh` wrapper/stance, and the swarm config. **Mine these for the
  *intent* of each gate; mine `~/dev/gate-proof/` for the *working mechanism*.**
  (Operator-private — review before publishing any of it.)

## 7. Honest scope & boundaries (don't oversell)
- This is a **process** transfer, not an **expertise** transfer. It reliably
  gives: a grilled spec, a built app, a hard-verified "it runs," a security/RLS
  gate, and a refusal to ship failure. It does **not** supply domain judgment
  (e.g., "this auth model is wrong for your users") — that's what the human
  escalation layer is for.
- **The marketplace is the hard part** — recruiting/vetting/scheduling engineers +
  liability is an ops business, not a coding task. The gate chain makes human
  review *cheap* (it pre-localizes the finding to a small slice), which is the
  unit-economics unlock — but the supply network is real work.
- **Static analysis only.** Never probe third-party live apps (unauthorized).
- Realistic ceiling for the pure-software part: ~70–80% senior-quality output;
  the human layer covers the rest. Market that boundary honestly — it's the
  feature, not the shortfall.

## 8. First task (start here)
**Port the gate-proof orchestration from bash to a typed TypeScript library** —
this becomes the reusable `gate` module every other layer calls.

1. Scaffold a Bun + TypeScript project here (`~/dev/drydock`), mirroring Harbor's
   conventions (`bun test`, `tsc --noEmit` must be green; strict TS).
2. Build `src/gate/` that:
   - runs each scanner as a pinned container (semgrep + custom `sqli.yaml`,
     gitleaks) and the RLS static check, against a target directory;
   - normalizes everything into a single typed `Finding[]`
     (`{ tool, ruleId, severity, file, line, message }`);
   - returns a `GateResult` (`pass: boolean`, `findings`, `blocking` count) and a
     `verdict` ("PASS" | "BLOCK");
   - exposes `runGate(targetDir, opts)` — the function the front door / loop calls.
   Reuse the exact scanners, the `sqli.yaml` rule, and the RLS logic from
   `~/dev/gate-proof/gates/` — only the **orchestration** moves to TS.
3. Add tests: BLOCK on a fixture with the three failure modes; PASS on the fixed
   fixture; assert findings come from the real scanners (or mock the container
   boundary for unit tests + one integration test that really runs them).
4. CLI entry: `drydock gate <dir>` printing the verdict + findings (parity with
   `gate-proof/gates/scan-target.sh`).

**After M1:** wire the gate behind a generator (run it automatically on freshly
*generated* code — "Option A"), then build the escalation hand-off (gate flags →
review packet → engineer → resume — "Option B"). Don't build the marketplace UI
until the gate-library + a generator loop are solid.

## 9. Definition of done for M1
`drydock gate ~/dev/gate-proof/app` reproduces the proof's verdict from typed TS
(not bash): BLOCK on the vulnerable app, PASS on the remediated one, with findings
sourced from real semgrep + gitleaks. `bun test` + `tsc --noEmit` green.
