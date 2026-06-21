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

> **Before proposing a direction change, read §10 (settled decisions).** A
> capable "just keep the CLI / skip the frontend / your user is a developer"
> counterargument recurs — it's been considered and resolved. We are building the
> **product**, not a personal dev tool.

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

## 10. Decisions log (settled — do not re-litigate)
A well-argued counterargument *will* recur — "keep opencode, port the bash gates
to TS, skip the frontend; your user is a developer running a CLI." It is correct
for a **personal dev tool** and wrong for **this product**. Resolved decisions:

1. **Target user = a non-technical operator** who cannot use a CLI, read a diff,
   or run opencode. NOT a developer. This is the market thesis (§2). Any advice
   premised on "your user is a developer" is answering the wrong question — discard it.
2. **The accessible front door is the product, not optional.** Deferred for M1,
   never abandoned. A non-technical person cannot use a TUI/CLI. (Fork bolt.diy — §3.)
3. **Customer-facing generation engine = bolt.diy fork / Agent SDK** (later).
   opencode-the-swarm stays only as the *operator's* prototyping tool — it is
   NOT the customer engine (provider-fragile, dev-oriented). Don't swap engines now;
   don't mistake the prototype engine for the product engine.
4. **Gates first — and SECURITY gates first.** Port `~/dev/gate-proof/` (SAST /
   secrets / RLS — the moat, catches the breach failures), NOT (only) the
   prototype's process checks (readme/pinning/hygiene), which linters/CI already do.
5. **What every road agrees on, do now:** port the gates to typed TS (= M1). It's
   independent of all decisions above, so it never blocks on this debate.

Decision date: 2026-06-20. Decided by the operator after weighing the counterargument.

## 11. Architecture: deterministic vs skill boundary
**Governing rule: _LLM proposes, deterministic disposes._** Anything that decides
*whether something ships* is deterministic, typed, and tested. Anything that
*interprets fuzzy human intent or generates novel content* is a skill (LLM). The
seam between them is always a **typed schema**: the LLM fills a structure;
deterministic code validates it and acts on it.

**Classification test for any component:** *if it gets the answer wrong, what
happens?*
- "Insecure code ships, or a check is skipped" → **deterministic** (non-negotiable).
- "A worse draft a downstream deterministic gate will catch anyway" → **skill** is fine.

If you can write a passing/failing test for it, make it deterministic. If you can
only judge it by reading the output, it's a skill — and its output **must flow back
through a deterministic gate before it ships.**

| Component | Layer | Note |
|---|---|---|
| Prompt intake (understand the request) | **Skill** | …but its *output* is a deterministic, schema-validated spec |
| Code generation | **Skill** | the one thing only an LLM does well |
| **The gates** (SAST/secrets/RLS/verify) | **Deterministic** ⭐ | the moat; pass/fail testable + unskippable |
| Auto-fix on a blocked gate | **Skill** → re-checked | LLM writes the fix; the gate confirms it actually passes |
| Severity / true-positive triage | **Deterministic-biased** | block by default; downgrade only *with justification*, never silent skip |
| buy-vs-build | **Hybrid** | registry = deterministic data; match = skill; recommendation = advisory |
| Routing (which gates apply) | **Deterministic** | "has DB → RLS gate; HTTP → SAST" is config logic |
| Pipeline order / loop control / retries | **Deterministic** ⭐ | the prototype's fatal flaw was putting this in a prompt |
| Escalation trigger + packet + specialty routing | **Deterministic** | human supplies judgment; the *mechanism* is code |
| **Deploy verdict** | **Deterministic** ⭐ | sentinel, unskippable, zero LLM |
| Domain knowledge (PRD craft, SOC2 checklist, secure-coding) | **Skill** | reference the LLM consults; the *enforcement* derived from it is code |

**The inversion (vs the prototype):** the prototype put *enforcement* in skills
(prompts) — which is exactly why the LLM skipped steps. Drydock makes enforcement
deterministic code and shrinks skills to *interpretation, generation, and
knowledge*. The LLM works **inside** a step; the **sequence and gating between
steps is TypeScript that cannot be talked past.**

## 12. M1 spec (corrected from an external "harbor-core" spec review, 2026-06-20)
An external spec was reviewed; adopt its bones, with these **binding corrections**:
- **Name stays Drydock** (not "Harbor"/`harbor-core` — collides with the existing
  Harbor repo).
- **Test runner: `bun test`** (not vitest — consistency with the skeleton + Harbor).
- **Gate set = the SECURITY gates** (`sast`, `secrets`, `rls`, launch-probe
  `verify`), ported from `~/dev/gate-proof/` — **NOT** the prototype's process
  checks (readme/pinning/latency/budget). Those are not the moat; linters/CI do them.
- **Findings stay structured** (`Finding[]`) — never flattened to `string[]`.
- **Engine: interface now, ONE implementation at M2, zero adapters in M1.** The
  gate library scans existing code and needs no engine. The *product* needs one
  (the generation step) — pick a single engine when wiring generation (lean
  **bolt.diy**: it's also the front-door UX; Goose/Claude SDK are headless
  alternatives). Build a *second* adapter only on a concrete need (cost/lock-in).
  Don't put the gate pipeline *on* the engine — gates run on output, engine-blind.

```ts
// src/types.ts
export type Severity = "critical" | "high" | "medium" | "low";
export interface Finding {
  tool: string; ruleId: string; severity: Severity;
  file: string; line?: number; message: string;
}
export interface GateVerdict {
  gate: string; status: "pass" | "block" | "escalate";
  findings: Finding[]; blocking: number; ranAt: string;
}
export interface Gate { name: string; run(projectPath: string): Promise<GateVerdict>; }
export interface Engine { generate(prompt: string, projectPath: string): Promise<void>; } // M2 seam — no impl in M1
```

```
src/
  types.ts          # Finding, GateVerdict, Gate, Engine (seam)
  gate/
    rules/sqli.yaml # custom CWE-89 rule (ported from gate-proof)
    sast.ts         # semgrep (+ sqli.yaml) in a container → Finding[]
    secrets.ts      # gitleaks in a container → Finding[]
    rls.ts          # static SQL/RLS check → Finding[]
    verify.ts       # launch + probe, multi-run
    index.ts        # runGate(dir, gates) → GateVerdict[]; deploy-sentinel logic
  cli.ts            # drydock gate <dir>
```
Severity mapping (preserve the proof's behavior): semgrep ERROR → `high`
(blocking), WARNING → `medium`, INFO → `low`; `blocking` counts `critical|high`
+ any secret. Separate the **pure parser** (JSON → Finding[], unit-tested) from
the **container run** (integration-tested) per §11.

## 13. Engine boundary & swap strategy (design-for-future)
We will start on **one** engine (bolt.diy) but must keep a later swap to Goose /
Claude SDK cheap. **Principle: invest in the *seam*, not the *adapters*.** An
interface is free; adapters are the expensive part you defer. Building multiple
adapters now = premature. Putting a clean interface at the engine boundary now =
cheap insurance that turns a future rewrite into a bounded swap.

**Cost of a later swap:**
- *Boundary kept clean* → implement one new `Engine` adapter + an event
  normalizer. ~1–2 weeks, one engineer. Not a rewrite.
- *Boundary leaked* (UI calls the engine's API directly; sessions stored in its
  format; gates assume its workspace) → months-long refactor.

The cost is set **now**, by discipline — not by how many engines exist.

**The two fault lines (keep both on OUR side of the seam):**
1. **UX coupling.** bolt.diy bundles engine + UI; its UI talks straight to its
   engine. Our front door must consume **our** normalized `EngineEvent` stream,
   never an engine's native API. Then a swap is invisible to the user.
2. **State coupling.** Durable state — spec/PRD, project files, gate results,
   session transcript — lives in **our** format. The engine is a **stateless**
   function over our state (this is why it's `dispose()`-able / ephemeral-container
   friendly). Provider/model is **config passed in**, so cost routing stays ours.

**bolt.diy approach = "C" (fork to MVP, seam from day one):** fork bolt.diy to
move fast, but immediately treat its engine as "behind my `Engine` interface" and
its UI as "a replaceable skin I own the data model for." Ship on bolt's momentum
without marrying it. (A = use its UI+engine coupled → fast but high swap cost.
B = own thin React front door from day one → clean but slower. C is the balance.)

**A swap should be invisible to users.** Same chat, same preview; the only honest
leak points are generation *quality/latency/supported-app-types* (a product
choice, not an architecture break) — contained as long as the UI reads our
normalized events.

Encoded in `src/types.ts`: `Engine` / `EngineSession` / `EngineEvent` /
`EngineConfig` — interfaces only, **zero implementation** until M2.

## 14. bolt.diy protocol — VERIFIED 2026-06-21 (+ the reconciliation task)
M2 built the bolt adapter (`src/engine/bolt/`) against an *assumed* wire format,
then committed (`45e8467`). The real bolt.diy source was afterwards inspected
(`stackblitz-labs/bolt.diy` → `app/lib/runtime/message-parser.ts`). Result:
architecture sound, assumption mostly right, **two concrete gaps found** — fix
these before building further on the bolt seam.

**Confirmed ✓:** bolt emits `<boltArtifact>` containing
`<boltAction type="file|shell|start">` — the three action types
`normalizer.ts` assumed are correct.

**Gap 1 — streaming vs single-shot.** bolt's `StreamingMessageParser` is stateful
and fires callbacks (`onActionOpen`/`onActionStream`) *incrementally* as chunks
arrive. Our `parseBoltStream` is one regex over the fully-accumulated string —
correct, but it loses the live "watch files appear" UX (silence, then a dump),
which matters for a non-technical audience. **Decide:** keep accumulate-then-parse
(MVP-ok, add a progress indicator) **or** port bolt's streaming callback parser
(live UX, more work).

**Gap 2 — single-artifact + attribute spelling.** `parseBoltStream` matches only
the FIRST `<boltArtifact>` and reads `filePath`; the real parser is
multi-artifact-capable and also extracts a `path` attribute (message-parser.ts:119).
If bolt emits >1 artifact, our regex **silently drops files after the first** — a
false-incompleteness bug. Confirm bolt's real emissions and fix.

**Still correct:** single coupling point (`BoltDriver`), normalizer/materialization/
deploy all on our side, engine-agnostic above the seam. **Do NOT vendor/fork
bolt.diy yet** — reading it was the right amount. Next task = reconcile
`src/engine/bolt/normalizer.ts` against `message-parser.ts`, fix gaps 1 & 2, keep
tests green; then the bolt adapter is genuinely audit-ready.

## 15. Roadmap (status + sequence)
Honest status. M1–M4 are committed; everything after is planned. The front door,
generation engine, and gates are grafted/built; the **moat** work (human
escalation + segment) comes later and is deliberately the hard part.

- **M1 — Gate chain ✓** (committed). sast / secrets / rls / verify + deploy sentinel.
- **M2 — Engine seam + bolt adapter ✓** (`45e8467`). `BoltDriver` seam, normalizer, gated deploy.
- **M3 — Escalation hand-off ✓.** Gate-flag → review packet → route → resume (the *mechanism*; the human marketplace is later — §16).
- **M4 — Live BoltDriver ✓** (`356e226`). Vercel `ai` SDK + derived bolt prompt; generation is live behind the seam.
- **NOW — Validate live generation** (chosen next). Wire a provider you have (opencode-go via `@ai-sdk/openai-compatible`, model `deepseek-v4-pro`), run a real generation, and treat the output as a findings list: clean protocol? Supabase/RLS code? gates pass first-try? does `verify` handle SPA vs node entry? Fix what real output reveals **before** building more.
- **NEXT (near-term, cheap, high-leverage):**
  - **Translation** — `Finding` → plain English. Curated `ruleId → explanation` dictionary (a content asset we own) + LLM fallback. Turns the gates into a *product* for non-technical users. **Highest near-term value.**
  - **Dependency-vuln gate** — `npm audit` / `trivy` in a pinned container (same pattern as sast/secrets). Closes a real security hole.
  - **Auto-fix loop** — LLM proposes a fix → re-gate disposes; bounded retries → escalate. Makes "blocked" *helpful*.
- **THEN — Adaptive intake → PRD → architecture front-half.** The "scoped + architected" complement to the gates' "secure + verified" (the gap Base44 leaves — §16). Output = a schema-validated spec/PRD (durable, ours) that feeds the engine. **Must be adaptive** (full rigor for real/complex apps; skip the ceremony for trivial ones — the system decides from the request). A *softer, copyable* edge — reinforcing, not the core moat.
- **THEN — Front door + hosting.** The non-technical browser UX (fork bolt.diy's UI consuming our `EngineEvent` stream, or our own thin React app), and **server-side execution** to run generated apps + the gates in the deploy path (replaces WebContainers; dodges its license).
- **LATER — The moat: escalation-as-product + segment go-to-market.** Build the on-demand-engineer marketplace (ops, not just code — vetting / scheduling / liability) and sell into the chosen segment (§16). **This is the defensible part; the gates are table-stakes.**
- **LATER — Prod-feedback** (post-deploy anomaly loop — needs hosting first) and **SaaS** (accounts, billing, multi-tenancy).
- **Skip for MVP:** refactor phase, methodology-select, buy-vs-build (power features, not MVP).

## 16. Product & positioning (strategic direction — firmed up 2026-06-21)
Current direction; some of it settled only in conversation, so revisit deliberately
— **except the compliance rule, which is binding.**

**Target segment — NOT "everyone."** We do not win the broad "AI app builder for
all" market (Base44 → acquired by Wix; Lovable $6.6B own it — head-on, we lose).
We target the slice where our difference is a *need, not friction*: **non-technical
people / businesses that handle sensitive data, where a leak = liability, and who
can't self-audit.** For them the gates are *the reason to choose us*; for a hobbyist
they're overhead. Beachhead candidates: accountants / bookkeeping, legal, real
estate, agencies building for clients — and the operator's own industries (a
dogfood + credibility advantage). **NOT hard-regulated / HIPAA as the *first*
beachhead** — the platform compliance lift is too heavy too early (see below).

**The moat (honest).** The gates are **table-stakes / credibility, NOT the moat** —
a gate list is copyable (a Wix-backed Base44 could add it). The defensible moat is
(1) the **human-escalation network** (an ops/marketplace, hard to copy) and (2) the
**segment positioning** (incumbents are structurally disincentivized to add
deploy-*blocking* gates — friction fights their speed metric; we own "we block,
they warn"). Build the human layer; don't mistake the gates for the product.

**Compliance scope — BINDING RULE, do not violate.** Drydock is a **security layer,
NOT a compliance certification.** We do **not** have SOC 2 or HIPAA "built in," and
a scanner *cannot* certify compliance — those are organizational / legal /
infrastructural regimes (policies, audits, BAAs, compliant hosting, breach
procedures). The `rls` gate is *one technical control*, not compliance. **Never
claim "HIPAA / SOC 2 compliant."** A future "compliance-aware" gate may *check the
technical controls a framework requires, flag gaps, and route the rest to a human*
— that **"helps you toward," never "makes you compliant."** Overclaiming compliance
is the one mistake a trust brand can't survive — and it's the exact overclaim we
position *against*.

**Differentiation vs Base44 / Lovable / Bolt.** They optimize *speed*: "fast prompt
→ app," with at most lightweight planning — **no real PRD, no architecture phase,
no enforced gates** — and a documented breach record (Lovable CVE-2025-48757;
Base44's own auth-bypass exposure). Our front-door + generation is **deliberately
grafted** (commodity — don't try to out-build them there). Our story:
**"scoped, architected, secure, verified" + a human safety net** vs their "fast,
runs, maybe wrong + maybe leaks." Differentiation stack = gates (table-stakes) +
PRD/architecture (softer, reinforcing) + human escalation (moat) + segment.

**Adaptive rigor** (applies to gates AND the PRD/architecture front-half). Rigor
scales to the task: full PRD / architecture / verification for real or complex
apps; **skip the ceremony for trivial ones** — the system decides the level from
the request. Forcing a PRD on "build a to-do app" recreates the friction we
criticize; a senior engineer doesn't write a PRD for a 10-line server.
