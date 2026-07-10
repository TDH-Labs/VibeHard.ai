# VibeHard — roadmap notes (beyond the current product)

Durable notes for work that is **out of scope for the current VibeHard build** but
intentionally captured. The in-scope roadmap is `PROJECT_BRIEF.md` §15; this file is
for future products / spin-offs and deferred sub-features.

---

## Future product: the AI Maintainer (a SEPARATE product)

**What it is.** An AI that *maintains a deployed app over its life* — not just builds
it once. It watches production, proposes fixes/upgrades, and ships them safely:

```
deployed app emits logs / a new CVE lands
  → prod-feedback detects the anomaly (or depvuln flags the CVE)
  → AI proposes a fix (the auto-fix loop, triggered by a PROD signal, not a build)
  → the FULL gate chain re-runs on the fix (correct · secure · RLS · verify)
  → regression check against the spec's acceptance criteria (must not break what worked)
  → low-risk + all-green → ship (with instant rollback); risk/judgment → human (§24)
```

**Why it's a separate product, not a feature of this one.** Touching *production* is a
different risk class than gating a build: a bad build never shipped; a bad prod change
hits live users and their data now. It needs its own surface, its own trust posture,
and infrastructure this product doesn't have.

**What it REUSES from VibeHard (why we're uniquely positioned to build it):** the hard
part of "AI maintaining prod code" was never the edit — anyone can prompt an LLM to
change a repo. The hard part is letting it touch production *without breaking or leaking*.
That safety **is** VibeHard's deterministic spine, already built: the gate chain (the
safety check on every AI change), auto-fix (the fixer), prod-feedback §20 (the sensor),
refactor-phase §22 (the iron-rule revert), escalation §24 (judgment → human), and the
**spec + PRD acceptance criteria as the invariant** the maintenance must preserve.

**What it ADDITIONALLY needs (the real build, in rough order):**
1. **Regression coverage** — the crux. The gates prove *correct + secure + boots*, NOT
   *"every feature that worked yesterday still works."* Turn the PRD acceptance criteria
   into executable regression tests; generated apps have thin coverage today.
2. **Hosting + deploy/rollback automation** — canary/blue-green, instant revert (§15).
3. **The prod-feedback scheduler** — continuous scan cadence (§20 deferred).
4. **Trigger wiring** — a feedback packet auto-kicks a maintenance iteration.
5. **Stricter human-approval policy in prod** — anything touching auth / money / sensitive
   data goes through a human even when the deterministic checks are green.

**The boundary that must NOT move:** never an autonomous AI deploy to production without
the gates passing AND a human owning anything that's a judgment or a risk (§11 + §24,
held *harder* than at build). Positioning: "AI maintainer **with a human safety net**",
never "fully autonomous AI editing your production."

**Why it matters:** for the non-technical sensitive-data beachhead, "we keep it running
and secure after launch" is the other half of the value prop (they can't maintain it
themselves — the whole reason they need us), and the moat (gates + escalation network) is
worth more in prod, where the stakes and the recurring revenue both live.

---

## Phase II: Enterprise Agent Builder (the "Holy Grail" market gap)

> Market sizing, competitive read, and the focus decision live in
> [`market-analysis.md`](market-analysis.md) (2026-07-08): lead with this Phase II
> direction, keep VibeHard.ai as the beachhead, do NOT run a standalone orchestrator GTM.

**The Market Gap.** No single platform natively combines all three layers required for
non-technical founders to build AI-first Service-as-Software businesses:

1. **No-Code Builders** (MindStudio, Relevance AI, Aisera) have the SOP Compiler but no
   BYOC orchestrator — cannot route sensitive data through their servers (kills enterprise
   legal / healthcare deals).

2. **BYOC Infrastructure** (Nuon, Northflank, Porter) have the orchestrator but require
   DevOps engineers to hand them compiled Docker images — non-technical founders are locked out.

3. **Agent Frameworks** (LangGraph, CrewAI) have the runtime template but are just code
   libraries — still requires hiring senior Python developers.

**The Unfair Advantage.** VibeHard is uniquely positioned to bridge all three:

* **Agent Runtime Template** — standardized backend loop (CrewAI / LangGraph) running on
  Fly.io, configured (not coded) by the SOP Compiler.
* **SOP Compiler** — conversational UI that turns "what triggers the agent? what does it
  do? where does output go?" into a workflow config file.
* **BYOB Orchestrator** — already built. Multi-tenant, data-sovereign, customer-VPC
  deployment, full safety-gate chain, at scale.

**What gets unlocked.** The first **No-Code Enterprise Agent Builder** — ease-of-use of
MindStudio with the data-sovereignty and compliance of Northflank / Databricks. Non-technical
domain experts (e.g., 20-year logistics veterans) can build enterprise-ready, HIPAA/SOX/GDPR
Service-as-Software companies without raising $2M for a DevOps + engineering team.

**TAM.** Not just therapists + bookkeepers (the current beachhead): every knowledge-work
vertical is addressable. Medical MSOs, legal services, recruiting, call centers, financial
advising, tax prep, compliance — potentially 1M+ service professionals globally who have
domain expertise but no infrastructure to deliver AI-first services at enterprise scale.

**The Build (rough order):**
1. **Standardized Agent Runtime Template** — pre-built FastAPI + CrewAI/LangGraph loop that
   loads a workflow config; deploy to Fly.io via the existing orchestrator.
2. **Integration Hub** — pre-wired connectors (OAuth, MCP servers, token storage) for
   common integrations (Gmail, Slack, Stripe, etc.); user clicks "Connect," orchestrator
   handles the OAuth dance and wires tokens into the runtime.
3. **SOP Compiler** — conversational builder that interviews the user, generates workflow
   config + database schema, feeds both into provisioning.
4. **Compliance Scaffolding** — vertical-specific templates (medical → PHI isolation,
   legal → evidence handling, financial → PCI scope) with gates already tuned.

**Why VibeHard, not a new product.** The safety gates, deterministic spec → PRD →
architecture pipeline, RLS enforcement, and multi-tenant isolation are already load-bearing.
This is an adjacent surface on the same engine, not a rebuild.

---

## Deferred refactor surfaces (current product ships only the explicit whole-app pass)

The current build ships `vibehard refactor <dir>` — an explicit, operator-invoked,
whole-app pass on a passing build (iron rule: re-verify, revert on break). Deferred until
there's a reason (an account layer, automatic triggers, a traction signal):

- **Add-on entitlement gating** — `AND (refactor enabled)` at the trigger point; one build
  + a per-account flag (NOT two builds). Becomes real with the SaaS/account layer; the
  explicit command is the opt-in for now.
- **Slice-scoped refactor at gated reviews** — the reviewer's discretion, scoped to the
  escalated slice, after the fix, re-verified. (Whole-app stays the deliberate step.)
- **Traction-triggered refactor** — promote a "prototype" to a full pass once §20 shows
  real usage.
- **Auto-run inside `build` at production rigor** — intentionally NOT done; a senior
  refactors when it pays off (a human's in the slice / it's earned it), not speculatively
  on every build.

---

## Product storefront — marketing site + copy (TODO), and the hosted app UI

**TODO — marketing site (design + copy).** A public site that sells the product to the
non-technical, sensitive-data segment (clinics / legal / accounting): visual/brand design,
positioning, and website copy. Lead with the value prop — "build a real app for your
business, with the security built in and an expert on call" — not the engineering.
Translate the moat (enforced gates + on-demand human engineer) into operator language.
§16-BINDING on every word: never "HIPAA/SOC 2 compliant / certified" — "helps toward,
never certifies." Needs a design/brand pass + landing / pricing / trust-&-security pages.

**The hosted app UI (bigger, same "storefront" theme).** The product itself: a web app
where a non-technical user types a prompt and watches build → gate → ship, with the gates
HIDDEN (enforced FOR them, not shown TO them — §1/§16) and holds/escalations surfaced in
plain language. Today VibeHard is a CLI the target user can't operate; this UI is what
stands between the proven engine and a real customer.

---

## Build target: hosted app vs. downloadable tool (found via dogfooding, 2026-07-08) — FIXED 2026-07-09

**Update 2026-07-09 — all four points below shipped** (`dd6e1e7`, `[next]`): `Spec.deployTarget`
threaded through intake → codegen brief → `verify`'s new "cli" LaunchPlan (run-once, judge on
exit code) → `/api/export` (zips the gate-approved workspace, gated behind the same sentinel
`deployGate` writes). Point 3's rewrite landed as designed, after real deliberation on where the
line should sit — see "Compliance/pii" below for the reasoning and the final rule. Point 4's
sequencing note held: this shipped after the workspace-storage fix, not before.


**The gap.** VibeHard only knows one output shape today: gate → deploy to a live URL with
its own database. A dogfooding request for a local-only TUI tool (Ollama-driven, single
user, no server) hit every gate tuned for that one shape and got misread as unshippable:
`verify` wants a bootable server ("no server to launch"); `compliance`/`pii` want a login
in front of anything sensitive-shaped, keyed off *data shape* not *is this multi-user* —
so a single-user tool with an API key in `.env` trips the same finding as an actual
CVE-2025-48757-style multi-tenant leak. Nothing in the platform can currently zip a
workspace or accept an upload either — confirmed empty (`grep` for download/upload/zip
across `web/` and `src/` turns up nothing product-facing).

**The real fix isn't "add a download button."** It's a build-target choice at intake
(`hosted-app` vs. `downloadable-tool`) that changes which gates even apply:
1. **Intake asks build target up front**, alongside the existing sensitivity questions.
2. **`verify` gets a downloadable-tool profile** — "does it run when invoked" (the declared
   entry point exits 0 / produces expected output), not "does it boot an HTTP server."
3. **`compliance`/`pii` key off actual multi-tenancy**, not data shape alone — a
   single-user local tool with secrets in `.env` isn't the RLS-leak pattern; the finding
   should ask "is more than one person's data ever in this workspace," not just "does this
   look like PHI/PII."
4. **A new terminal step for downloadable targets**: zip the gate-approved workspace,
   strip `.git`/`.env`/anything `src/credentials` would treat as a secret, serve it as a
   download gated behind the same sentinel signature as a deploy — no download without a
   passing gate line, same invariant as `stampSentinel`.

**Sequencing note.** Don't build the zip/download step before the workspace-storage bug
below is fixed — no point exporting a workspace that might silently be the stale copy from
the other machine.

---

## Parallel workstreams overwrite shared config files (found via dogfooding, 2026-07-09) — FIXED 2026-07-09

**The bug.** Codegen runs multiple workstreams CONCURRENTLY within a tier
(`runTiers`/`src/util/pool.ts`, confirmed ≤4 at once), and each workstream's generated files get
materialized via a plain full-file overwrite (`Bun.write(abs, seg.content)`,
`src/engine/bolt/engine.ts`) with no merging and no locking. Confirmed live: a real build had
TWO separate workstreams (`data-access` and `tui-framework`) each independently `create:
package.json` at the same path in the same run. Whichever finishes last wins outright — the
other's declared dependencies, scripts, and `main`/`bin` entry point are silently discarded, not
merged. This is NOT specific to the downloadable-tool work — it's a structural gap in the
parallel-codegen orchestration that predates it and would hit any multi-workstream build (hosted
or downloadable) where more than one workstream needs to touch `package.json` (or
`package-lock.json`, `tsconfig.json` — same pattern, same risk).

**Confirmed downstream damage in one real run:** the FINAL `package.json` had
`"main": "dist/index.js"` (implying a `tsc` build step must run first) even though the
`project-selector-tui` workstream's own log explicitly said it built a plain-JS entry
(`src/index.js`) specifically to satisfy the downloadable-tool entry-point contract — a LATER
workstream's overwrite silently reverted that.

**The `EINTEGRITY` failure is UNRELATED — traced and fixed separately (2026-07-09).** Originally
logged above as "plausible fallout" from the race; that was wrong. Diffing the lockfile's stored
hash for `terminal-size@4.0.1` against the live npm registry's real one showed they differ by
exactly 2 characters out of 86 (`...RLR+8N1jLJ...D...` vs `...RLT+8N1jLJ...x...`) — a genuine
corrupted download or version mismatch would differ completely (SHA-512 avalanche effect); a
near-miss like this is the signature of the MODEL free-generating a plausible-looking lockfile
(same failure class as the earlier hallucinated Dockerfile digest, see below) rather than the
registry or the race condition. Root cause: `src/engine/bolt/engine.ts`'s file-materialization
write path had no filter — any `<boltAction type="file" filePath="package-lock.json">` the model
emitted was written verbatim. Fixed by refusing to write model-authored lockfiles at that one
chokepoint (`LOCKFILE_BASENAMES` guard, covers `package-lock.json`, `npm-shrinkwrap.json`,
`yarn.lock`, `bun.lock`, `bun.lockb`, `pnpm-lock.yaml`) — the real lockfile can only come from
`ensureInstalled()`'s actual npm/bun install now. All 5 call sites (codegen, change, art-director,
fixer, refactor) share this one write path, so the fix covers initial generation and every
autofix pass. Tests: `src/engine/bolt/engine.test.ts` — "hallucinated-lockfile guard".

**Shipped 2026-07-09: went with fix direction #2 (merge, not overwrite).** New
`src/engine/bolt/merge-config.ts` (pure, unit-tested) + a module-level per-absolute-path async
mutex in `engine.ts` (`withFileLock`) at the exact same write chokepoint the lockfile guard
already lives at. When a workstream is about to write `package.json`/`tsconfig.json` and a file
already exists there (an earlier-finishing workstream in the same tier), it's merged
deterministically instead of blindly overwritten:
- dependency maps (`dependencies`/`devDependencies`/`peerDependencies`/`optionalDependencies`) +
  `scripts`: UNION, incoming wins on an exact key collision (neither value is "more correct"
  without semver-solving, so last-declared is as good a rule as any — the point is nothing gets
  silently DROPPED).
- `main`/`bin` — the exact field that regressed in the confirmed incident: EXISTING WINS on a
  real conflict. The first workstream to establish an entry point owns it; a later, differing
  value is dropped and surfaced as a `message` event (`merged package.json with another
  workstream's version — "main" — kept ...`), never silently applied.
- everything else: existing wins if present, else incoming fills the gap.

The lock is REQUIRED, not optional — `mapPool` genuinely runs up to `VIBEHARD_CODEGEN_CONCURRENCY`
(default 4) workstreams concurrently, each constructing its own `BoltSession`
(`cli.ts`'s `streamGeneration`), so a naive check-then-write merge would itself race. Module-level
because the race is ACROSS session instances, not within one. Verified with a genuine-concurrency
test (`Promise.all` over two real `BoltSession`s writing the same path at once, not sequential
awaits) — confirms both the lock and the merge hold under real concurrent execution, not just in
a single-threaded replay. Tests: `src/engine/bolt/merge-config.test.ts` (pure merge logic,
including the exact main-regression scenario as a named test) + `engine.test.ts` ("shared-config
merge, not overwrite").

Direction #1 (single-owner) and #3 (collision detection at the architecture level) remain
un-built alternatives — not needed now that #2 closes the actual damage, but worth revisiting if
a merge ever produces a genuinely wrong result for a field this policy doesn't anticipate.

**Stray Docker/Depot text in a `verify:build-failed` message — root-caused + fixed 2026-07-09.**
Not contamination — the message was accurate to a DIFFERENT code path than the one it claimed.
The `build` and `cli` launch kinds' sandboxed exec branches (`runInFlyExecSandbox`, EPIC #32)
build an ephemeral Docker image (the synthesized Dockerfile's own baked-in `RUN npm install`)
BEFORE running the actual command (`npm run build` / `node <entry>`) inside it. When that IMAGE
BUILD itself fails — before the real command ever runs — the captured log is BuildKit/Depot's own
output (`"load build definition from dockerfile"`, `"failed to solve: process ... did not
complete successfully"`), but `summarizeBuild`/`cliRunFinding` unconditionally labeled it
`"`npm run build` exited N"` / `"`node <entry>` exited N"` regardless — sending whoever reads the
finding chasing the app's build SCRIPT when the real problem is one layer down, in the sandbox's
own image. Fixed: `sandboxExecFinding()` (`src/gate/verify.ts`) detects BuildKit's own
`failed to solve:` / `error building:` / `load build definition from dockerfile` framing and
emits an accurately-labeled `sandbox-image-build-failed` finding instead, falling through to the
existing (correct) command-failure path otherwise. Tests: `verify.test.ts`, both the `build` and
`cli` kind sandbox describe blocks, replaying the actual captured BuildKit log from the incident.

---

## Compliance/pii: single-user + downloadable-tool auth severity (decided + shipped 2026-07-09)

**The question.** `compliance`'s `unauthenticated-sensitive-data` (critical, blocking) fires on
any sensitive-shaped data with no login — correct for the CVE-2025-48757 threat model (an
unauthenticated PUBLIC endpoint), wrong for a tool that never gets a URL at all. `pii.ts` turned
out NOT to be part of this — its two findings (`pii-in-logs`, `pii-in-url`) are about leakage
mechanisms, orthogonal to authentication; only `compliance.ts` needed to change.

**The options weighed**, against three real segments (tool builders selling to their own paying
users; a turnkey-internal-tool-that-later-opens-to-paid-users trajectory; non-technical founders
building a Service-as-Software business — the Phase II bet): downgrade on `tenancy=single-user`
alone was rejected — a single-user *hosted* app still has a live URL anyone who finds it can
reach, and "turnkey internal → later external" is exactly the trajectory where a rule keyed on
declared user count (not reachability) could let a real leak ship on a later redeploy without
ever re-triggering the check. None of the three segments actually needed the broader relief —
all are hosted/multi-tenant by nature — so the narrow rule cost nothing.

**The rule that shipped**: BOTH `tenancy === "single-user"` AND `deployTarget ===
"downloadable-tool"` must hold — the code must genuinely never get a live URL. Either alone
stays critical/blocking. Protected against gaming by the existing fail-closed defaults:
`deployTarget` defaults to `"hosted-app"` on anything missing/malformed, which alone disqualifies
the exception — an adversarial or malformed intake response can't accidentally earn the
downgrade. Downgraded to `medium` (advisory) on a distinct ruleId (`unauthenticated-local-tool`,
not a severity-conditional message on the existing one) — still surfaced, still visible, just
doesn't hold the build. `src/gate/compliance.ts`, tests in `compliance.test.ts`.

---

## Tenant workspace storage isn't durable or machine-consistent (found via dogfooding, 2026-07-08) — ACUTE PART FIXED 2026-07-09

**Update 2026-07-09.** This wasn't just a risk — it materialized: a routine deploy wiped an
in-progress dogfooding build the same night this was written (ephemeral local disk, no
volume, no shared storage). Fixed the acute failure mode immediately: a durable Fly Volume
mounted at `/root/.vibehard`, single machine (`fly.toml`, commit `b8ec05e`). Verified live —
a file written to the volume survived a full machine restart. This closes "wiped on deploy"
and the split-brain (single machine now = single source of truth) for as long as the
platform runs on one machine. It does NOT close the underlying architecture gap below —
re-open this before scaling past one machine.


**The bug.** `fly.toml` has no `[mounts]` — each Fly machine has its own local disk, and
Fly round-robins requests across the fleet. A tenant's build directory
(`/root/.vibehard/tenants/<id>/apps/<app>/`) only exists on whichever machine ran the last
step that touched it. Confirmed live: after a dogfooding retry, machine A held the full
source tree (PRD/SRS/`.vibehard/spec.json`/`app/`/`src/`, stamped 00:43) while machine B
held a different, smaller file set (`package.json`/`Dockerfile`/`fly.toml`/`server.js`,
stamped 00:59) for the SAME app. `status`, `retry`, and every subsequent orchestrator
message can land on either machine with no session affinity — so a fix round can silently
run against a stale or partial copy, or a status check can report on the wrong machine
entirely.

This is a superset of the already-tracked #55 (workspaces wiped on deploy) — it's not just
deploy-time loss, it's routine cross-request inconsistency any time the fleet has more than
one machine, deploy or not.

**Fix directions (needs a scoped decision, not a quick patch):**
- A shared Fly Volume (or NFS-alike) mounted identically on every machine — simplest
  mental model, but Fly Volumes are typically single-machine-attached, not natively
  multi-writer; would need per-machine volumes + explicit sync, or a single-writer
  constraint on build machines.
- Move the tenant workspace to object storage (S3-alike) as the source of truth; each
  build step pulls-before/pushes-after instead of assuming local disk persists.
- Sticky routing: pin a tenant's build session to one machine (Fly's `fly-replay` /
  instance targeting) so at least a single build's request sequence stays consistent, even
  if it doesn't solve cross-deploy durability.

Ties directly to EPIC #32 (Build sandbox / per-build isolation, in progress) — the sandbox
work should settle this as part of defining where a build's workspace actually lives.

---

## EPIC #32 — concurrent builds starve each other on shared host CPU (found via dogfooding, 2026-07-09) — PARTIALLY CLOSED

**Confirmed live.** Running two real `vibehard fix`/`build` pipelines at once on the single shared
Fly machine caused semgrep to fail to even start (`"SAST scan did not run (exit -1)"`) and an
`npm install` to be killed by `SIGTERM` after blowing through its own timeout — both were
resource contention, not code defects (confirmed by immediately re-running each build SOLO,
which converged cleanly). This was long-tracked as EPIC #32 (the sandbox/isolation epic) but had
never actually been hit under real concurrent load before.

**What was already built (found, not new):** `src/substrate/fly-sandbox.ts` (isolated deploy+boot)
and `src/substrate/fly-exec-sandbox.ts` (isolated one-shot command exec) already exist and were
already wired into the `container`/`build`/`node` `runVerify` paths via `resolveSandboxHost` —
production just never had `FLY_API_TOKEN` set, so every path silently fell back to local
execution (by design — see the fallback comment on `VerifyDeps.flyHost`). Nobody had actually
turned it on.

**Shipped 2026-07-09:**
1. **`cli` launch kind (downloadable-tool) sandbox wiring** — this was the ONE launch kind with
   NO sandbox path at all, regardless of token config; it always ran `npm install` + the entry
   point directly on the host. Now mirrors `build`/`container`/`node`: prefers
   `runInFlyExecSandbox` when a Fly host is configured. `cliRunFinding` extracted as a pure
   helper so the sandboxed and local paths produce the identical `cli-run-failed` finding shape.
2. **Cross-process host lock** (`src/util/host-lock.ts`, `withHostLock`) — a `mkdir`-based
   advisory mutex serializing every heavy host-side subprocess (npm/pip install, `npm run build`,
   `docker build`, `tsc --noEmit`, and the semgrep/gitleaks/trivy scanners) across ALL `vibehard`
   CLI processes on one machine. This is the fix for the ACTUAL contention observed — `Bun.spawnSync`
   only blocks within its own process, so two separate CLI invocations (two builds, a retry
   racing an in-flight fix) have no shared JS state to coordinate through; a lock directory is
   the standard cross-process primitive. Stale-holder reclaim (dead pid or >10min old) and a
   bounded max-wait (proceeds WITHOUT the lock after 5min rather than ever hang a build forever —
   contention is a performance problem, not a correctness one, the opposite of the gate's
   fail-closed default) keep this from becoming its own hazard.

**Correction (2026-07-09, later same night):** `FLY_API_TOKEN` IS actually set in production
(confirmed via `fly secrets list --app vibehard-platform`) — the paragraph above, written
earlier tonight, was wrong. The sandbox paths (container/build/node/cli) are therefore already
live, not falling back to local execution. Caught this by observing a real
`fly machine run --dockerfile ... npm run build` child process spawned during a live dogfood
re-run. Still open: whether this token is scoped down to sandbox-provisioning only or is a
broader/personal-account token (worth checking — `fly` doesn't expose a token's own scope from
the CLI; would need to check how it was originally issued), and what the per-build Fly cost
this is already incurring looks like (no cost tracking/alerting on it yet).
- The SAST/secrets/depvuln scanners are permanently host-side by design (they only read source
  as data, never execute it — no security reason to sandbox them) — the host lock is their
  PERMANENT contention fix, not a stopgap pending token activation, unlike the install/build/exec
  paths above.
- No concurrency CAP at the `Platform`/`BuildRunner` orchestration layer (`src/platform/`) —
  today nothing stops N tenants' builds from all entering the (now-serialized-by-lock) heavy
  work queue at once; the lock prevents them from corrupting each other's runs, but doesn't
  bound how many pile up waiting. A real queue/worker-pool belongs at that layer once build
  volume justifies it.

**Shipped 2026-07-09 (later): whole-platform concurrency cap.** Added `BuildProgressStore.countRunning()`
(`src/platform/build-store.ts`), implemented on both `FileBuildProgressStore` and
`PgBuildProgressStore` — counts tenants with `status === "running"` by reading the shared store,
not an in-process counter, for the same reason `isBuildRunning`'s per-tenant guard had to move off
a local `Map` back on 2026-07-07: the platform runs on 2+ Fly machines behind one load balancer
(`min_machines_running = 2`), so any one machine only ever sees builds IT personally spawned. Wired
into `web/server.ts` as `atBuildCapacity()` (`countRunning() >= VIBEHARD_MAX_CONCURRENT_BUILDS`,
default 4), checked in all three build-spawning routes (`/api/build`, `/api/redeploy`+`/api/polish`,
`/api/change`+`/api/rollback`) immediately after the existing per-tenant `isBuildRunning` guard —
returns 503 with a distinct "platform is at capacity" message so it's not confused with the
per-tenant 409 "you already have a build running." This is a coarse admission-control gate, not the
real queue/worker-pool noted above — a tenant who gets 503'd just has to retry, there's no queueing
or backpressure signal beyond that. Tests: `src/platform/build-store.test.ts` (`countRunning`
contract cases run against both backends).

**Open finding, NOT acted on (2026-07-09): `FLY_API_TOKEN` may be broader-scoped than it needs to
be.** `fly tokens list -o personal` shows non-expiring (2126) org-level tokens named "Drydock" /
"Drydock replacement" / "Organization Token" — consistent with `FLY_API_TOKEN` being an
organization-wide token rather than one scoped narrowly to sandbox machine provisioning for this
one app. `fly` doesn't expose a token's own scope from the CLI, so this is circumstantial, not
confirmed. Deliberately not rotating or replacing this token autonomously — it's a live production
credential backing real deploys, and swapping it is exactly the kind of access-control change that
needs the account owner's explicit decision, not an agent's. If tighter scoping matters, the fix is
minting a new deploy-scoped token via `fly tokens create deploy` (or an org token restricted to just
this app) and swapping `FLY_API_TOKEN` in `fly secrets set` — a five-minute change for Adam to make
or explicitly authorize.

## An "advisory, never blocks" LLM check crashed the whole build anyway (found live by Adam, 2026-07-09) — FIXED 2026-07-09

**Confirmed live.** A resumed build (spec/PRD/SRS/SAD already restored from saved work) died at
"reviewing the plan for risks (adversarial)" with an uncaught `whitespace-only model response` error
and dumped a raw Bun stack trace — internal file paths, line numbers, `Bun v1.3.14 (Linux x64
baseline)` — straight into the user-facing build log. The review-stage model (deepseek-v4-pro via
OpenRouter) returned empty/whitespace text on all `generateTextResilient` attempts (the same
degeneration mode first seen 2026-07-04, now recurring).

**Root cause:** `reviewFrontHalf` (`src/spec-review/review.ts`) called `await opts.adversary(bundle)`
with no error handling at all, despite its own doc comment being explicit that this check is
advisory-only: "an LLM finding never blocks — only objective checks do" (§11). The design intent was
that the red-team pass can never stop a build; in practice, an *exception* from that same call could
kill the build outright — a bigger hazard than the thing it was designed not to have. Nothing in
`cli.ts`'s `main()` caught it either, so it propagated all the way to Bun's own crash reporter, and
because build subprocesses stream their raw stdout/stderr straight into the SSE log (`runStep`'s
`pump()` in `web/server.ts`), that internal crash trace became the last thing the user saw.

**Fixed, two layers:**
1. `reviewFrontHalf` now wraps the adversary call in try/catch. On failure it fails OPEN — treats the
   run as zero adversarial findings plus one `adversary-unavailable` (low severity, never routes to
   `needsHuman`) note explaining the reviewer model failed — instead of losing the whole build. This
   makes the code match the behavior the doc comment already promised.
2. `cli.ts`'s `main()` invocation gained a last-resort top-level try/catch: any *other* future
   uncaught exception now prints one clean `build failed: <message>` line and exits nonzero, instead
   of a raw internal stack trace reaching the user's log. Exit code semantics are unchanged, so
   `web/server.ts`'s existing blocked/error status handling (keyed on exit code, not log content) is
   unaffected — this only changes what the human watching the log actually sees.

Tests: `src/spec-review/review.test.ts` (adversary-throws case), full suite green (1120 pass).

## Cost credits ran to $0 with no warning + reason-tier cost split (2026-07-09) — FIXED 2026-07-09

**What happened:** the verification build run to prove the review-stage fix worked failed
immediately, on the very first LLM call, with `This request requires more credits... You requested
up to 6000 tokens, but can only afford 2482`. Checked the account directly against OpenRouter's
`/api/v1/credits` endpoint: `total_credits: 115, total_usage: 115.18` — the platform's OpenRouter
account had run to essentially $0 with **no warning anywhere** (task #37, cost governance, is still
pending). This blocked every build on the platform, including Adam's own in-progress one, not just
the verification run — a much bigger problem than the bug that prompted the check.

**Fixed: pre-flight balance check.** New `src/platform/provider-budget.ts` (`checkOpenRouterBudget`)
queries OpenRouter's live `/api/v1/credits` before a build is allowed to start, using whichever key
will actually be used for that build (the tenant's BYO key if set, else the platform's — read from
the already-resolved child-process `env`, so it's never wrong about which account is on the hook).
Below a configurable floor (`VIBEHARD_MIN_CREDITS_USD`, default $1 — a single planning stage costs
cents, so this is a "don't even start" floor, not a tight budget) the build is refused up front with
a clear message, instead of burning what's left on a build that dies mid-plan. Wired into
`web/server.ts`'s `buildStream` BEFORE any durable "running" state is written, so a refusal never
leaves a tenant looking like they have a stuck build (the same lesson as the concurrency-cap and
`isBuildRunning` fixes earlier tonight). Fails OPEN if the check itself errors (network hiccup,
malformed response) — an unrelated glitch in the balance check must never block an otherwise-healthy
build; only a CONFIRMED low balance blocks. Verified live: with the account still at ~$0 at the time
of writing, hitting `/api/build` now returns a clean 503 immediately instead of spawning a build that
dies several stages in.

**Also (explicit decision, 2026-07-09): local models are NOT wired into VibeHard.** Adam has a real
local Ollama lineup (`qwen3.6:latest` 36B MoE, `gemma4:12b-mlx`, etc.) and asked whether they had a
role — decision: no, not in this codebase. VibeHard is a live multi-tenant cloud service; a model
running on someone's laptop can't back it without a tunnel that ties the product's uptime to that
laptop being on and reachable. `src/config/models.ts` stays cloud-only by design (see its own doc
comment). Local models may still have a role in the OFFLINE eval harness (#38, run on a developer's
own machine) — that's a separate, not-yet-built question, deliberately out of scope here.

**Also: split the `reason` tier into `reason` (SAD + review — compounding-risk stages, stay on
`deepseek-v4-pro`) and a new `reason-lite` tier (intake, spec, PRD, SRS, refactor, polish — either
bounded/fail-safe by design or self-correcting, moved to `deepseek-v3.2`).** `v3.2` prices ~49% of
`v4-pro`'s prompt cost and ~37% of its completion cost on OpenRouter's live catalog (checked
2026-07-09), while staying in the same model family — a same-vendor swap, not a cross-vendor jump,
as the safer first move. **Not yet A/B'd against `v4-pro` on real output** (credits are at ~$0, so
there's nothing to test with yet) — do that once credits are restored, before trusting this beyond
"probably fine." A cross-vendor candidate (`qwen/qwen3-235b-a22b-2507`, cheaper still and possibly
higher quality — it's a much larger model) was evaluated and intentionally NOT chosen for this first
move, to avoid stacking an unvalidated model-family change on top of an unvalidated price change.

Tests: `src/platform/provider-budget.test.ts` (7 cases), `src/config/models.test.ts` (new file, 9
cases covering the tier split + override precedence). Full suite green.

## mustImplement was declared, never scored + first full live verification run (2026-07-09/10)

**Wired `EvalCase.mustImplement` into a real scorer.** `src/eval/harness.ts`'s `runEval` only ever
checked "did the gate chain pass" — a corpus case could pass while silently missing the feature it
was declared to prove. Added `functionalCheck` (default: the real `llmFunctionalReviewer`, same one
`vibehard functest` uses) — runs after a gate-passing build, only when `mustImplement` is set. A
`missing` feature now fails the case; `partial` is surfaced, doesn't block. The check's own failure
fails open (never blocks a case on an unrelated reviewer hiccup) and is reported separately. Tests:
`src/eval/harness.test.ts` (+11 cases). Also closed a parallel gap found the same night: 4 advisory
LLM call sites (`steering/suggest.ts`, `orchestrator-llm.ts`, `translate-llm.ts`, `fleet/induct.ts`)
were manually confirmed fail-open earlier tonight but only `suggest.ts` had a test proving it — added
the missing regression tests to the other three so a future break of review.ts's exact bug class
fails a test, not a live build.

**First full live verification build since tonight's fixes — a real, honest result.** Ran
`vibehard build` for a simple todo-list prompt against the deployed pipeline with credits restored.
Progress vs. every earlier attempt tonight: front-half (spec/PRD/SRS/SAD) completed cleanly on the
new `reason`/`reason-lite` split, the adversarial review ran and correctly surfaced 4 real advisory
findings (including a genuine intent-fidelity catch: the architecture added an unrequested auth
workstream despite the spec saying `auth: none`) WITHOUT crashing the build, and codegen produced a
real app. **It still did not ship.** The gate/autofix loop oscillated across 3 full attempts (verify
findings went 1→2→2, sast/prod-readiness flipped in and out) and self-detected it wasn't converging
("no progress — the same 2 blocking finding(s) recurred... escalating early") — then correctly
escalated to human review (`::held esc-11w8arv`) after 3 extension attempts and 45+ minutes of
wall-clock time, rather than looping forever or shipping something broken. That's the safety design
working, not a pass.

**Root cause of the two HIGH-severity residual blockers, found and fixed, not guessed.** Two
findings looked like real defects at first read: `clean-verify-failed` (`npm ci`/`npm install` on a
fresh checkout killed by `SIGTERM`) and `sandbox-boot-failed` (the Depot image build stalled loading
the Dockerfile). Before touching anything, re-ran the EXACT SAME `npm install` on the exact same
workspace by hand, no timeout: **226 seconds, exit 0, "added 32 packages" — it installs fine.** The
generated app was correct; `src/gate/verify.ts`'s `CLEAN_TIMEOUT_MS` (120,000ms) was killing a
legitimate clean install nearly half again as slow as its own budget. Doubly wrong on inspection: a
CLEAN install (no cache, nothing to reuse) inherently has MORE work than a warm one, yet had a
TIGHTER timeout than `SUBPROCESS_TIMEOUT_MS` (300,000ms, used elsewhere in the same file for the
warm path). Raised `CLEAN_TIMEOUT_MS` to `300_000` to match. This is a timeout correction, not a
loosened gate — the install/build still has to actually succeed; it just now gets a fair amount of
time to do it in, matching what the codebase's own general-purpose subprocess budget already treats
as reasonable elsewhere.

**Not yet re-verified live** — the timeout fix hasn't been proven against a fresh end-to-end run yet
(that costs more credits + time; do it next). The escalated build (`esc-11w8arv`) is still queued for
human review and was NOT force-resolved or reset.

## Proactive timeout audit (2026-07-10) — sweeping the whole class, not waiting for each to fail live

Adam's pushback after the `CLEAN_TIMEOUT_MS` fix: finding and fixing one thing per live run is still
reactive, even when the fix itself is solid. Answer: grep every timeout constant in the gate/autofix
pipeline and check EACH for the same miscalibration category (a magic number, disconnected from the
codebase's own shared budget, that's tighter than the real work it bounds) — before another live run
finds the next one the expensive way.

Found and fixed two more, same family:
- **`src/autofix/missingdeps.ts`**: a per-package `npm install` (deterministic dependency-add
  strategy) had a local `120_000` — the EXACT value that just failed for a full clean install. This
  install can run on a cold workspace (no `node_modules` yet), so it's exposed to the identical
  cold-network risk. The file's own doc comment already records a prior live incident with the
  symptom signature of a silent partial failure ("added 3 of 4 missing deps, missed one... the loop
  oscillated to a hold") — consistent with, though not proven to be, this same timeout being hit
  intermittently. Aligned to `SUBPROCESS_TIMEOUT_MS` (300s, the codebase's own established budget).
- **`src/autofix/fixer.ts`**: `npx tsc --noEmit` (the batched typecheck the LLM fixer reads) had a
  local `180_000`, disconnected from the shared constant. `npx` resolves/downloads `typescript` over
  the network if it isn't already local — the same cold-network exposure class. Aligned to
  `SUBPROCESS_TIMEOUT_MS`.

Checked and left alone, WITH reasoning recorded (not just skipped silently):
- `gate/migrate.ts`'s `APPLY_TIMEOUT_MS` (30s) — bounds an in-process pglite/Postgres statement, no
  network/registry dependency, not the same risk class.
- `verify.ts`'s `PROBE_ATTEMPTS × PROBE_INTERVAL_MS` (~3s boot-health probe) — bounds a running
  production server responding to HTTP after it's already started, not a cold install; no direct
  evidence of failure. Not touched without evidence, same discipline as the fix itself.
- `SUBPROCESS_TIMEOUT_MS` (300s) itself — now the value 4 different call sites share. No direct
  failure evidence against it yet (unlike the 120s/180s numbers above, which had either a live
  incident or a documented prior incident). Worth the same scrutiny the moment one does fail.

This is the actual proactive move: a mechanical sweep for the WHOLE bug class in one pass, not a
promise to "build an eval harness eventually." Still not verified end-to-end — same caveat as the
`CLEAN_TIMEOUT_MS` fix: correcting a timeout is not evidence it's the ONLY thing wrong, only that
it's no longer the thing MOST likely to produce a false block. Full suite green.
