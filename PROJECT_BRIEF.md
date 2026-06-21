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

**Binding invariant — gates fail CLOSED.** A gate that *could not run* must never
report PASS. "The scanner didn't run" must be distinguishable from "scanned,
clean" — otherwise a setup failure silently turns enforcement into a no-op that
reports green (the **false-PASS class**). Concretely: a scanner that errors,
produces no valid output, or can't find its inputs returns a **CRITICAL
`scan-failed` finding (which blocks)** — never an empty (passing) result. This
class has bitten **three times**: the Pi `pipefail`/glob bug (no source detected →
nothing ran → "green"), Drydock's relative-Docker-path bug (empty named volume →
scanned nothing → PASS), and the `sast`/`secrets` fail-open caught + fixed
2026-06-21 (`JSON.parse(out) … catch {}` → 0 findings → PASS on scanner error).
**Treat any "0 findings" path as suspect until you've proven the check actually
executed.** Separate the *pure interpretation* (`interpretSemgrep`/`interpretGitleaks`)
from the I/O so the fail-closed logic is unit-tested without a container.

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
- **THEN — Escalation *workflow* (MVP — the human safety net, as glue not a built app).** **In MVP scope** because the operator is *non-technical and cannot be the reviewer* — so 1–3 vetted SWE reviewers are needed from launch for the product to deliver its "+ human" promise. Build it as **glue** (full design §24): finding + generated code → a private **GitHub** repo (Issue/PR) + a **Slack** alert (**first-come-first-serve** claim); reviewer fixes via **PR**; the gate **re-runs as CI** on the PR (re-gate); verdict = approve / false-positive label; **human proposes, gate disposes**; audit = the PR history. Builds **zero** reviewer UI. Validates without hosting (re-gate-passes = "would deploy"); the literal deploy waits on hosting. Dependency: this is a *people* task too (recruit + NDA 1–3 reviewers — §16 profile, vet on real findings).
- **LATER — Escalation *at scale* + segment go-to-market (the moat).** The marketplace ops the glue defers: recruiting/vetting a real reviewer pool, **specialty routing** (Harbor "rooms"), a built reviewer console, **scoped-slice access** (reviewer sees only the flagged slice, not the whole customer codebase), billing / SLA, liability. **This is the defensible part; the gates are table-stakes.**
- **LATER — Prod-feedback** (post-deploy anomaly loop — needs hosting first) and **SaaS** (accounts, billing, multi-tenancy).
- **Captured & specced, sequenced later (NOT skipped):** the front-half skills
  (buy-vs-build, refactor-phase, rigor/parallelism-select), the production-readiness
  gates, the prod-feedback loop, and compliance-beyond-RLS now have production specs
  in **§18–§23** (grounded in the bash+skills prototype). They are built at the
  rigor the task calls for (§16), after the NEXT tier — captured ≠ now.
- **Out of scope (decided):** opencode-swarm's 18-agent config and Harbor's
  progressive-disclosure chain — see §23 (the transferable ideas are kept; the
  machinery is not).

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

## 17. Candidate gates backlog (classified — add at the right time, not on impulse)
Proposed gates beyond the shipped four (sast / secrets / rls / verify). Captured so
they aren't lost — but **these are breadth, not the current leverage.** Per §15 the
near-term order is: validate live generation → translation → **dep-vuln gate** →
auto-fix. Everything below comes *after* that. All of these obey §16 **adaptive
rigor** — run at higher rigor for real/maintained apps, skipped for throwaways.

**Near-term security gate (NOT backlog — already in §15 NEXT):**
- **dep-vuln** — `npm audit` / `trivy` in a pinned container → `Finding[]`. Real
  security hole (supply chain). Same pattern as sast/secrets. Do this one soon.

**Tier 1 — Maintainability (deterministic; ONE lint gate, not six).** Low-stakes
(maintainability, not security/correctness) but real for the "maintained over weeks
/ agency hands off to client" segment. Get them all from a single `gate/lint.ts`
running ESLint (JS/TS) + Ruff (Python) with a config — do **not** build separate
gates:
- file size / function length (`max-lines`, `max-lines-per-function`)
- cyclomatic complexity (`complexity` / Ruff)
- naming consistency (lint naming rules)
- documentation coverage (`jsdoc` / `pydocstyle`)
- "no-comment" / comment anti-patterns (opinionated; lowest value)
Track: §15 "widen the chain," one gate, later.

**Tier 2 — Observability (deterministic-ish but PRESCRIPTIVE; post-hosting).** Only
meaningful once we define a logging/observability contract and have hosting +
prod-feedback to consume it. Premature before then:
- structured-log gate (`app.jsonl` exists + schema-valid)
- request / correlation IDs present in log lines
- error boundaries / graceful error handling (partial exception — reliability-tier,
  framework-specific)
Track: part of the **prod-feedback / hosting** phase (§15 LATER).

**Tier 3 — Architecture review (NON-deterministic / skill; advisory; later).** A
senior-skill LLM agent assesses structural health (god files, separation of
concerns, redundant abstractions). **Designed correctly:** it does **NOT block**
(architecture quality is judgment, not a verifiable pass/fail — never put an LLM in
the enforcement path, §11) and it **writes a note to `build-status.md`** for the
next iteration (advisory, feeds-forward — same pattern as prod-feedback packets).
**Elevation:** a *high-stakes* structural concern it flags is a natural trigger for
**human escalation** (route to a real senior engineer — §16 moat), not just a note.
So it's both an advisory gate and a feeder for the escalation layer.
Track: later; advisory-only; ties into the human-escalation moat.

**Tier 1 — more deterministic production-readiness gates (extend the lint gate):**
- **README gate** — a plain-language README is present and non-trivial (can
  LLM-draft a starter). **Adaptive: blocks at production rigor, warns at prototype.**
  Matters for "agency shares the build with a client."
- **dependency pinning** — deps locked to exact versions (no `^` / `>=` / `latest`),
  so a future dep bump can't silently break the app.
- **clean-env verify** — copy to a fresh dir, install from scratch, run — proves it
  works on a *new* machine, not just where it was built. Heavier (full install);
  shareability tier.

**Tier 2 — more reliability/hosting-coupled gates (extend the observability batch):**
- **container hygiene** — Dockerfile has a non-root `USER`, `.dockerignore` exists
  (no host `.env`/secrets leaked into the image), no secrets baked in. Conditional
  on Docker/hosting.
- **graceful shutdown** — app handles `SIGTERM` cleanly within N seconds (no
  `SIGKILL`, no dropped in-flight requests). Reliability tier; any served HTTP app.
- **prod-feedback anomaly loop** — *(Pi source: `reference/prototype/skills/prod-feedback/` + `scan.sh`)*
  the back-edge: deployed app emits structured logs → a scheduled scan detects
  anomalies (latency spike, webhook drop, error-budget burn) → writes a
  `PROD_FEEDBACK_PACKET` into build-status.md for the next iteration.
  **Non-blocking, feeds-forward.** Needs hosting first — this *is* the observability
  phase (§15 LATER).

**Build-process steps (skills at the intake/PRD/architecture front-half — §15 — not blocking gates):**
- **buy-vs-build** — *(Pi: `reference/prototype/skills/buy-vs-build/`)* at PRD
  scoping, check build scope against a registry of mature APIs (Textract, Clerk,
  Stripe, Twilio…); flag BUY-vs-BUILD with rationale. **Advisory — surfaces the
  option, the human decides, never auto-procures.** Deterministic registry + LLM
  match. Real senior-engineer move (agents default to BUILD); pairs with the segment
  (don't let a non-technical user rebuild Stripe).
- **rigor-select** — ⚠️ Drydock reframe of Pi's `methodology-select`. **Pi's version
  chose superpowers-path vs swarm-path (the prototype's two execution models) — that
  does NOT map to Drydock** (single bolt engine). The Drydock analog is the §16
  **adaptive-rigor** decision (prototype vs production rigor, set from the request),
  NOT an execution-model fork. Capture it as the rigor mechanism, not Pi's skill.
- **refactor-phase** — *(Pi: `reference/prototype/skills/refactor-phase/`)* after
  verify passes, before DONE, production rigor only: an LLM scores code *quality*
  (not correctness) → refactors → **re-runs verify (all N runs); a refactor that
  breaks verify is REVERTED**; bounded to 2 passes. Skill (refactor) + deterministic
  (re-verify disposes). Maintainability tier.

**Compliance beyond RLS — BOUNDED BY THE §16 BINDING RULE:**
- **compliance-aware gate** — *(Pi: `reference/prototype/skills/compliance-posture/`)*
  when the spec flags sensitive data, evaluate SOC 2 / ISO applicability, retention,
  access-control models, sanitization, audit logs (beyond the single RLS control).
  ⚠️ Pi's skill *"blocks DONE if a control is missing"* — **Drydock's version must
  obey §16:** it *checks the technical controls a framework requires, flags gaps,
  and routes the rest to a human.* It **"helps toward" compliance; it NEVER
  certifies.** Must not become a "HIPAA / SOC 2 compliant" claim.

**Stack/lint auto-detection — a PRIMITIVE, not a gate (resolved).** Earlier listed
as "link auto-detection" (a typo for *lint*). It's the detection that identifies a
project's language so the right linter / test runner / README check runs. **NOT a
separate gate** — fold it into the lint gate + verify. ⚠️ The *lesson* is what
matters: Pi's bash used `ls *.py *.js 2>/dev/null | grep -q .` under `set -o
pipefail`, which failed whenever *any* glob didn't match → "no source found" → NO
lint/tests/README gate ran, yet it looked green (a **false-PASS**). Fixed in Pi
with native glob expansion (`has_glob()`). For Drydock (TS, not bash) that specific
bug is moot, but the principle is the **§11 fail-closed invariant**: detection that
can't identify the stack must fail closed, not silently skip.

**Priority reminder (unchanged):** all of the above are *captured backlog*, not
*next*. Nothing is "skip for MVP" any longer, but the leverage is still
validate-generation → translation → dep-vuln → auto-fix (§15). Captured ≠ now.
**§18–§23 below are the production specs** for the pieces that were previously
one-liners — grounded in the bash+skills prototype (`reference/prototype/`,
`~/dev/gate-proof/`, the operator's rooms). They define the *shape* to build to;
sequencing is still §15. Where the prototype's v0 code diverged from its own spec,
**these sections take the intended design, not the v0 shortcut** (noted inline).

## 18. The verify gate — full reliability contract (was just "multi-run")
Verify is the product's **reliability promise**: "it actually runs, repeatably,
on a clean machine, and shuts down cleanly." The shipped `verify.ts` does the
node-launch / SPA-build probe; this is the full contract it grows into.

- **Adaptive rigor levels** (§16): `VERIFY_RUNS = 1` prototype · `3` default · `5`
  production. **"Pass" = ALL N runs green** — not a majority, *all*. One flake fails
  the whole gate. Default 3.
- **"One green run proves nothing."** A single green run says nothing about races,
  leaks, flaky tests, or time-dependent bugs — re-run N times. (Already the
  `verify.ts` philosophy; this is the binding statement of it.)
- **Sentinel.** Each run's success marker is `HARD_VERIFY_PASS` (exit 0); the gate
  passes only when every run emits it. Drydock's deploy ratchet (`.gate/HARD_VERIFY_PASS`)
  already mirrors this — one sentinel writer, written iff all gates pass.
- **Retry budget — default 5.** Each FAIL → fix → re-verify cycle decrements it
  (this is the §15 auto-fix loop's bound). Budget exhausted with verify still
  failing → **STOP; never claim DONE; route to human escalation** (§3 moat); write
  `BLOCKED — verify failed after N attempts` to the durable status.
- **Failure packet (typed, deterministic — §11)** — reuse the `Finding`/packet flow:
  `{ stage: "build"|"spec"|"test", producingAgent, verifyExitCode, verifyLastLine,
  failureExcerpt (~500 chars), claimedDoneButWasnt: bool, attempt, budget }`.
- **Routing by stage (deterministic).** `build` → re-run codegen (auto-fix loop);
  `spec` → back to the front-half (the PRD/architecture was unbuildable as written);
  `test` → the verify harness itself is wrong (not the build). The router is code;
  the fix inside each is the skill.
- **Clean-env verify (`verify-clean.sh`) — runs ONCE before the multi-run loop.**
  Catches "works on my machine." Steps: `mktemp -d` → copy source (`rsync -a` with
  excludes `.venv|node_modules|.git|target|dist|.next|.terraform|__pycache__`, `cpio`
  fallback) → detect package manager by manifest (python `requirements/pyproject` ·
  npm `package.json` · go `go.mod` · rust `Cargo.toml`; none → not-applicable) →
  **install from scratch** (`uv`/`npm ci`/`go mod download`/`cargo fetch`) → **run
  tests** (`pytest`/`jest`|`vitest`/`go test`/`cargo test`) → all under a portable
  timeout (default 120s). Sentinel `CLEAN_VERIFY_PASS`. Proves a *fresh* machine can
  install + run, not just the pre-seeded workspace. (⚠️ the v0 `verify-clean.sh`
  still has the pipefail/glob idiom in two `elif` branches — production must use the
  `has_glob` form, §11.)
- **Graceful shutdown (reliability sub-check).** A served app must handle `SIGTERM`
  cleanly within N seconds — no `SIGKILL`, no dropped in-flight requests.
- **Adaptive:** N and the heavy checks (clean-env, container, refactor) scale with
  rigor; a throwaway prototype runs N=1 and skips them (§16).

## 19. Production-readiness gate specs (lint · container · pinning · README)
The "more production-ready" deterministic gates (§17 Tier 1). All obey **§11
fail-closed** (detection that can't identify the stack fails closed, never silently
skips) and **§16 adaptive rigor** (block at production, warn at prototype).

- **Lint — ONE gate, auto-detected (not six).** Detect the stack by file presence,
  run the family's fallback chain:
  - Python (`*.py`): `ruff` → `pylint` → `flake8` → `py_compile` (+ `mypy --strict` advisory)
  - JS/TS (`*.{js,ts,jsx,tsx}`): `eslint` (if config) + `tsc --noEmit --strict` (hard fail)
  - Go (`*.go`): `go vet ./...` · Rust (`*.rs`): `cargo clippy -D warnings` → `cargo check`
  - Shell (`*.sh`): `shellcheck` (advisory) · Docker (`Dockerfile`): `hadolint`
  - Terraform (`*.tf`): `terraform fmt -check -diff`
  Lint is the cheapest stage — if it fails, the run never reaches launch/build.
- **Container hygiene** (if `Dockerfile`): non-root `USER` (block @prod), base image
  pinned by `@sha256` digest (block @prod), `.dockerignore` present (advisory —
  secrets leak into build context), `docker build` succeeds (advisory).
- **Dependency pinning:** exact versions, no `^`/`>=`/`latest`, so a silent bump
  can't break a shipped app.
- **README gate:** a plain-language README present + non-trivial (LLM can draft a
  starter); matters for "agency hands a build to a client."

## 20. prod-feedback — the production back-edge ("keeps working after deploy")
The outer loop that closes the lifecycle: the deployed app emits structured logs →
a scheduled scan detects anomalies → a feedback packet feeds the next iteration.
**Non-blocking, feeds-forward** (never an LLM in a blocking path — §11). Needs
hosting (§15 LATER), but the contract is fixed now. Drydock types the packet (like
`Finding`/`EscalationPacket`); the scan is deterministic.

- **JSONL log schema** (app emits, append-only, one event/line → `logs/<project>/app.jsonl`):
  `{"ts":"…Z","project":"<slug>","event":"request|webhook|error","route":"/x",
  "source":"stripe","latency_ms":12,"status":200,"error":null}`. PII **sanitized
  before logging** (ties to §21). ⚠️ Production fix: model webhook health *in-schema*
  — the v0 keyed off an undocumented `webhook_delivery:"failed"` field, so an app
  emitting the documented schema never triggered WEBHOOK_DROP.
- **Anomaly types (4) — use the INTENDED baseline/rate definitions** (the v0 used
  cruder per-line counts; production restores the design):
  1. **LATENCY_SPIKE** — route p95 > 2× rolling-24h baseline, or a single request >
     5× route median → HIGH if p95 > SLO, else MEDIUM.
  2. **ERROR_CLUSTER** — ≥3 identical errors (same route + error type) in window → MEDIUM.
  3. **WEBHOOK_DROP** — a source that sent ≥1 event last window sent 0 this window
     (business hours) → HIGH (silent data loss).
  4. **ERROR_BUDGET_BURN** — window error rate (5xx/total) > SLO budget → HIGH if
     >2× budget, else MEDIUM.
  (+ optional **DEPENDENCY_DEGRADATION** — external-call p95 > 3× baseline → MEDIUM.)
- **Error-budget math.** SLO availability (default 99.9%) → budget = (1 − SLO) of
  window events; burn = failures/allowed; tiered (>2× budget → HIGH). (v0:
  `allowed = round(total×(1−SLO/100))`, floor 1, breach when `failures ≥ allowed` —
  the count-based fallback.)
- **Window + cadence.** Scan window 15m; scan cadence every 5m (Harbor cron /
  launchd in the prototype → a Drydock scheduled job); rolling 24h latency baseline;
  previous-window comparison for webhooks.
- **Feedback packet (`PROD_FEEDBACK_PACKET`).** Fields: `anomaly_type, severity,
  detected_at, window, measured vs baseline vs SLO, route/source, sample_log_lines
  (3), suggested_fix_focus`. **HIGH → build-status.md** (drives a fix iteration);
  **MEDIUM → prod-notes.md** (trend, non-blocking). A packet unaddressed **>72h
  escalates** (higher-severity note + notification → human). `suggested_fix_focus`
  becomes the next iteration's first focus; it never auto-deploys.

## 21. Compliance framework beyond RLS — BOUNDED BY §16
RLS is **one of seven** controls a sensitive-data customer needs. The prototype's
`compliance-posture` gate (triggered when the spec flags `sensitive_data`) checks
all seven. **Drydock keeps the technical-control checks but obeys the §16 binding
rule: it checks controls, flags gaps, routes the rest to a human — it "helps
toward," it NEVER certifies. Never emit "HIPAA/SOC 2 compliant."**

The 7 controls (BLOCK = a verifiable technical control; advisory = recording/judgment):
1. **Data classification** (advisory/recording) — data types (PII/PHI/financial/
   creds), jurisdiction (US/EU/HIPAA/GLBA), retention requirement. Drives which
   other checks apply.
2. **Retention + deletion** (BLOCK) — a retention policy + a **hard-delete**
   mechanism (not a soft-delete flag) + verifiable purge + GDPR erasure for EU.
   Block if sensitive data is stored with no retention + no deletion path.
3. **Access control** (BLOCK) — role-based, authenticated (no unauth sensitive
   endpoints), **row-level not just table-level**, audit log of access. Block if
   readable without auth, or shared-tenant with no row isolation.
4. **RLS** (BLOCK — *shipped today as the `rls` gate*) — every sensitive table
   RLS-enabled, app connects as a non-superuser, policies filter by tenant/user from
   session, cross-tenant test.
5. **Sanitization** (BLOCK) — no raw PII in logs/errors/stack traces; sanitize
   before trust-boundary crossings (analytics, vendor APIs). Block if PII is logged
   in plaintext or errors leak sensitive fields.
6. **Governance** (advisory — policy the build should *enable*) — data-handling
   policy, DPA-readiness, breach-notification path, access-review cadence. The build
   enables them (audit logs, access-review tooling); it doesn't *claim* them.
7. **SOC 2 / ISO applicability** (advisory/classification) — from the data
   classification, flag which Trust Services Criteria apply (Security always;
   Availability if SLA; Confidentiality if sensitive; Processing Integrity if
   financial; Privacy if PII) and which controls are build-blocking vs org-level.
   ISO Annex A technical controls only (A.5/A.8/A.9/A.10/A.12).

**Disposition (the §16 reframe of the prototype's blunt "BLOCK DONE"):**
- **Build-blocking technical controls missing** (no RLS on multi-tenant PII, no
  retention/deletion, PII in logs, no auth, no encryption at rest/transit) → **BLOCK**,
  deterministically, exactly like `sast`/`rls`. These are verifiable.
- **Org-level gaps** (SOC 2 audit, DPA execution, ISO cert, breach runbook) →
  **SURFACED + routed to a human** (§3), never blocked-as-noncompliance, never
  claimed as compliant. The deterministic core checks technical controls; the
  judgment ("does this framework apply / is this gap acceptable") is the skill/human.

## 22. Front-half build-process skills (intake → PRD → architecture)
Skills that run **before** codegen — the "scoped + architected" half (§15 THEN).
Output is a schema-validated spec/PRD (durable, ours); adaptive rigor (§16).

- **buy-vs-build** (advisory, at PRD scoping). Check each requirement against a
  registry of **~10 mature-service categories** — document-processing (Textract/
  Document AI), auth (Clerk/Auth0), payments (Stripe), notifications (Twilio/
  SendGrid/Resend), search (Algolia/Meili/Typesense), observability (Sentry/Datadog),
  jobs/queues (Inngest/Trigger.dev), database (Supabase/Neon/Turso), vector-RAG
  (Pinecone/pgvector), LLM inference. **4-step rubric:** (1) registry covers it? no →
  BUILD; (2) cost viable for the unit economics? no → BUILD-with-rationale; (3)
  compliance/data-residency OK? no → BUILD; (4) integration simpler than building?
  no → BUILD; else **BUY**. **Advisory** — surfaces the option + rationale in the
  PRD; the human decides; default BUILD; **never auto-procures**. Pairs with the
  segment: don't let a non-technical user rebuild Stripe.
- **rigor & parallelism select** (the Drydock reframe of Pi's `methodology-select` —
  §17). Two deterministic decisions made from the request/plan, *not* an
  execution-model fork:
  - **Adaptive rigor** (§16): prototype (N=1, skip ceremony) vs production (full
    PRD/architecture, verify N=5, refactor, compliance) — chosen from signals
    (sensitive data? real users? maintained over time?).
  - **Parallel vs sequential codegen** *(the operator's question — captured as a
    design option to revisit when the front-half exists).* The architecture phase
    produces a **dependency graph of workstreams**; **independent** workstreams may
    be generated by parallel codegen sub-tasks, **dependent** ones sequentially. The
    decision (which are independent) is **deterministic from the plan**; the LLM
    codes inside each sub-task. This is a *single-engine execution strategy*, **not
    the opencode swarm** (§23) — adaptive (only when the plan has parallelizable
    parts). Record the rationale for auditability.
- **refactor-phase** (production rigor only; after verify passes, before DONE).
  Checkpoint the passing tree first (`git stash` / `.refactor-backup` — "the passing
  build is sacred"). A reviewer scores **quality, not correctness** (duplication,
  function length / single-responsibility, coupling to I/O, error paths,
  testability, missing edge tests) → a `REFACTOR_BRIEF` of concrete targets. The
  coder makes **behavior-preserving changes only** (no features/API/config). **Re-
  verify all N runs — any failure → REVERT to the checkpoint, record REJECTED +
  reason.** The iron rule: *a refactor that breaks verify is reverted, no
  exceptions.* **Bounded to 2 passes.** Skill (score/refactor) + deterministic
  (re-verify disposes).

## 23. Explicitly OUT of scope (with the transferable lesson kept)
- **opencode-swarm (18-agent config).** The operator's prototyping tool —
  provider-fragile, 18 role→model assignments. **Not the Drydock engine** (§10.3:
  single bolt.diy/SDK engine; don't mistake the prototype engine for the product
  engine). The model-assignment evidence is opencode-specific and not carried over.
  **Transferable idea kept → §22:** parallel-vs-sequential codegen sub-tasks driven
  by the plan — a single-engine execution strategy, not a multi-provider swarm.
- **Harbor progressive-disclosure chain** (`agent_map → room → skills_index →
  SKILL.md`; `harbor sync`/`skill-assign`; `config.toml [skills.rooms.*]`). Harbor's
  room/skill *discovery* substrate serves a general multi-domain agent environment;
  **Drydock is single-purpose** (one pipeline: intake → generate → gate → deploy)
  and needs no room routing or progressive skill discovery. Drydock still uses the
  Harbor *primitives* it actually needs (audit, session, budget, isolation — §6),
  just not the discovery routing.
- **Transferable lesson that DOES carry (already §11):** the `has_glob`/`pipefail`
  false-PASS — detection that can't identify the stack must **fail closed**, not
  silently skip. TS-native makes the specific bash bug moot, but the invariant
  governs the stack-detection primitive behind §19's lint gate.

## 24. Escalation workflow — MVP design (glue, not a built platform)
**Why this is MVP, not later:** the operator is **non-technical and cannot review
code**, so the "+ human safety net" in §1 requires **real SWE reviewers from
launch**. The *marketplace ops at scale* stays post-MVP (§15 LATER); the **review
workflow** is MVP because without it the differentiating promise isn't delivered.
Build **zero** reviewer UI — glue tools engineers already use.

### The flow
```
gate blocks (or auto-fix exhausts / hits a judgment call)
  → finding + the generated code land in a private GitHub repo (Issue + branch/PR)
  → Slack alert to the reviewer channel — FIRST-COME-FIRST-SERVE claim (react / button)
  → reviewer (in GitHub, where code review lives):
       confirms or marks false-positive, and if confirmed submits the fix AS A PR
  → our gate RE-RUNS as CI (GitHub Action) on that PR  ← re-gate
  → passes → deploy proceeds  (deploy itself needs hosting — §15)
```

### Why GitHub + Slack (and not a built console)
- **GitHub already *is* the reviewer platform:** Issue = the ticket, self-assign =
  the claim, the repo = full code context, **PR/diff = the structured fix**,
  approve/label = the verdict, **Actions = our gate as CI = the re-gate**. We build
  none of it.
- **Slack** = the fast alert + the **first-come-first-serve** claim (engineers won't
  watch GitHub in real time).
- **Pattern preserved:** the human **proposes** (the PR); the deterministic gate
  **disposes** (re-gate). The human's fix is *never* trusted directly — it flows
  back through the gate, exactly like auto-fix. The `false_positive` verdict is a
  **waiver** and MUST be auditable (logged) — the PR history is that audit.

### First-come-first-serve — fine for MVP, with the known caveat
FCFS (Slack react / GitHub self-assign) optimizes for *speed*, not *fit*. For a
small **vetted pool (1–3 people)** that's correct and simple. **Specialty routing**
(security → AppSec; RLS → Supabase; architecture → senior full-stack — the Harbor
"rooms" idea) and quality controls are **§15 LATER (at scale)**, not now.

### The reviewer profile + vetting (the *people* half — §16)
1–3 reviewers, **NDA'd + identity-verified** (they see customer code). Profile:
security-literate (not a generalist), deep in the generated stack
(TS/React/Next/Supabase/Postgres), judgment over speed-coding, accurate
*block-or-clear* discipline, clear written rationale, reliable/available.
**Vet by testing on REAL findings** (hand them the dogfood outputs — the `.next/`
false positives, a real RLS gap, the `next` CVE — and see if they distinguish
true/false positives and propose the right minimal fix). Résumés tell you nothing;
a 15-minute practical audit tells you everything.

### MVP boundary (build now vs defer)
- **Build (MVP glue):** GitHub repo/Issue/PR convention, gate-as-GitHub-Action
  (re-gate on PR), Slack alert + FCFS claim, the verdict→waiver audit, packet =
  the `Finding` we already produce.
- **Defer (§15 LATER, the moat/ops):** a built reviewer console, specialty routing,
  scoped-slice access (reviewer sees only the flagged slice, not the whole codebase
  — the gate already localizes it), billing/SLA, recruiting a large pool, liability
  structure.
- **Dependencies:** validate the core loop first (the n=3 diversity runs); the
  literal deploy step needs hosting (§15); and recruiting the 1–3 reviewers is a
  people task, parallel to the wiring.
