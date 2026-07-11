# Build Substrate — PRD (requirements)

> Stage 2 of 3. The SPEC's intent elaborated into requirements with testable acceptance
> criteria, the NFRs, and the buy-vs-build calls. Every requirement below traces to a
> specific, cited failure mode found during research (`docs/ROADMAP.md`'s 07-08/09 dogfooding
> entries, and direct reads of `web/server.ts` / `src/orchestrator-glue/build-tools.ts` /
> `src/substrate/fly-exec-sandbox.ts`), not a hypothetical.

## Functional requirements

### R1 — `WorkspaceStore` seam + Tigris implementation
Pull the tenant workspace as a whole-tree tar from object storage at build-worker start;
push a fresh tar at each checkpoint (R2).
- **AC1.1** A workspace pulled and then pushed unchanged round-trips byte-identical (no
  silent mutation from the tar step itself).
- **AC1.2** A checkpoint push that fails (network error, quota, auth) does **not** proceed
  to worker teardown — the build is held, retried with backoff, and only fails the build
  outright after a bounded retry budget is exhausted (never a silent drop).
- **AC1.3** A fresh tenant/app with no prior workspace pulls cleanly to an empty starting
  state (first-ever build for that app).

### R2 — `BuildWorker` seam + E2B sandbox implementation
Dispatch one ephemeral E2B sandbox per build, running the platform's own pre-built custom
template image (not a per-invocation image build from the workspace — see SPEC decision #2).
The sandbox pulls the workspace (R1), runs the unmodified `bun src/cli.ts build/fix <dir>`
pipeline against local disk exactly as today, checkpoints per autofix iteration (not per
stage, not per whole loop), and is always torn down — success, failure, or stop.
- **AC2.1** A build that completes normally leaves the worker torn down and the final
  workspace state pushed to `WorkspaceStore`.
- **AC2.2** A build worker killed mid-iteration (simulated: force-kill the sandbox via the
  E2B API during a run) leaves the workspace at its LAST successfully pushed checkpoint, not
  an earlier or later state, and a subsequent `retry` (R4) resumes from exactly that point.
- **AC2.3** The worker's own teardown never runs before its final checkpoint push has
  succeeded or exhausted retries (R1.2) — verified by a fault-injection test that fails the
  push and confirms the sandbox is NOT killed.
- **AC2.4** A build worker crash that prevents even a final checkpoint push (hard OOM, host
  eviction) does not leave an orphaned sandbox running indefinitely — closed by R7's sweep
  (backstopped by E2B's own `timeoutMs` auto-expiry — confirmed real, not by this
  requirement's own machinery alone).
- **AC2.5 (confirmed 2026-07-10, live)** Code running inside a build worker sandbox can
  create and tear down a second, independent E2B sandbox via a plain HTTP call to E2B's
  control-plane API, using an API key threaded into the worker's own env — the exact nested
  pattern the `verify` gate's own sandboxed exec depends on. Verified directly: sandbox A
  created sandbox B (`POST /sandboxes`, got a real `sandboxID` back) and deleted it (`DELETE
  /sandboxes/{id}` → 204) entirely from code executing inside A; a post-test API list call
  confirmed zero orphaned sandboxes remained. Not yet verified in the same live test: running
  an actual command inside the nested sandbox (only create+delete were exercised) — low risk,
  since command execution is the SDK's standard, unrelated-to-nesting code path, but worth a
  quick follow-up check before treating R2 as fully closed.

### R3 — Durable live build log + reconnect replay
An append-only log store the build worker writes lines to; the web tier's SSE endpoint polls
for new lines and forwards them to the browser.
- **AC3.1** A client that disconnects and reconnects mid-build resumes from its last-seen
  position — no duplicate lines, no gap, no reliance on the browser having buffered anything
  itself.
- **AC3.2** Log write throughput does not degrade as a build's log grows — a plain append
  (not a read-modify-write of a growing blob) confirmed via the schema in the Architecture
  doc (`build_log_lines`, not a reuse of the `tenantKv` blob-overwrite table).
- **AC3.3** Every log line that reaches the browser has passed the same sanitization
  discipline (§21) `web/server.ts`'s existing SSE pump already applies — no secret in a log
  line, worker or local.
- **AC3.4** Retention: old log lines are pruned per some bounded age/count per build (matches
  the existing `.slice(-50)`/`.slice(-200)` discipline elsewhere in the codebase) — not
  unbounded growth.

### R4 — Single dispatcher replacing both existing local-spawn call sites
`web/server.ts`'s `buildStream()` (`/api/build`, `/api/redeploy`, `/api/polish`,
`/api/change`, `/api/rollback`) and `src/orchestrator-glue/build-tools.ts`'s
`realBuildTools().retry()` both call one dispatcher that talks to `BuildWorker` (R2) instead
of spawning a local subprocess.
- **AC4.1** A chat-driven "retry" while an SSE-driven build is already in flight for the same
  tenant is refused (or queued, not run concurrently) — closing the confirmed-live race
  where `retry()` spawns unconditionally today with no `isBuildRunning`/`atBuildCapacity`
  check.
- **AC4.2** Every existing route that triggers a build (`/api/build`, `/api/redeploy`,
  `/api/polish`, `/api/change`, `/api/rollback`, and chat "retry") goes through the SAME
  dispatcher — no second, independent local-spawn code path survives the migration.
- **AC4.3** `atBuildCapacity()`'s cross-machine concurrency cap (already Postgres-backed,
  unchanged) continues to correctly bound total concurrent builds platform-wide once
  dispatch happens through the new path.

### R5 — Cooperative stop
Replace `/api/build/stop`'s `running.get(tenantId)?.kill()` (a local `Bun.Subprocess`
handle, meaningless once the process isn't local) with a durable stop-flag the worker polls
between internal steps.
- **AC5.1** A stop request against a build running on ANY machine is honored — not just one
  that happens to be handled by the machine that dispatched it.
- **AC5.2** The worker checks the stop-flag between internal steps (gate runs, autofix
  iterations), not only between checkpoints — a stop request doesn't have to wait out an
  entire in-progress checkpoint interval to take effect.
- **AC5.3** A stopped build still completes its checkpoint-push-then-destroy contract (R2.3)
  — stopping is not an excuse to skip the durability guarantee.

### R6 — Scoped secrets propagation to the worker
The worker fetches its env (tenant BYO LLM key, integration keys, steering rules — the same
values `buildStream()` assembles in-process today) via a scoped, single-use, expiring token
minted at dispatch time, calling back to an internal platform endpoint — never passed
directly as E2B sandbox-creation env vars.
- **AC6.1** The token is usable exactly once (or until a short TTL expires, whichever first)
  — a captured token can't be replayed against a later dispatch.
- **AC6.2** No tenant secret (LLM key, integration key, Supabase service-role key surfaced
  via a gate/deploy step) appears anywhere in E2B's own sandbox-creation config or
  API-visible metadata for the ephemeral sandbox.
- **AC6.3** The callback endpoint itself is scoped to return ONLY the secrets for the one
  build the token was minted for — never a broader tenant secret set.

### R7 — Heartbeat-based staleness + orphan sweep
Replace `sweepStaleRunning()`'s "web process just booted" inference with a heartbeat the
worker writes on an interval; a periodic, independent sweep flags/destroys E2B sandboxes
whose worker hasn't heartbeat in N minutes.
- **AC7.1** A build whose worker died silently (no clean teardown) is detected as stale
  within a bounded window (not "only on the next web-tier redeploy," which may be days).
- **AC7.2** A build that's genuinely still running for 45+ minutes (a real observed duration)
  is NOT falsely flagged stale — the heartbeat interval and staleness threshold are chosen
  with real build duration data, not an arbitrary short window.
- **AC7.3** An orphaned build-worker sandbox (heartbeat stopped, no clean teardown) is
  destroyed by the sweep within a bounded window, independent of any one worker's own
  `finally`-block cleanup succeeding, and independent of E2B's own `timeoutMs` auto-expiry
  (a real backstop, but not a substitute for the sweep's admission-control cleanup — a stale
  build record can still occupy a tenant's slot after the sandbox itself has already expired).

### R8 — Minimal per-build cost tracking
At minimum, record compute-seconds consumed per build (including nested sandboxes spawned
by the platform's own `verify` gate running inside a worker).
- **AC8.1** Every build's cost record is queryable after the fact (even if only a raw
  compute-seconds number, not a dollar figure) — not zero visibility, matching the existing
  gap ROADMAP.md already flags as "no cost tracking/alerting" on the current single layer.
- **AC8.2** Nested sandbox spend (verify gate's own sandboxed-exec calls, run from inside a
  build worker) is attributed to the SAME build's cost record, not lost as a second,
  invisible layer.

### R9 (separate, unblocked by R1–R8) — `Orchestrator.pendingConfirm` durability
Move the pending-confirm slot (the yes/no gate before "ship") from `Orchestrator`'s
in-process `Map` into the same durable per-tenant store already used for the outbound inbox.
- **AC9.1** A "ship" proposal and its "yes" confirmation land correctly even when routed to
  two different web-tier machines by the load balancer — no silent re-classification of
  "yes" as a fresh, unrelated message.

## Non-functional requirements (NFRs)

**Security:** tenant secrets never reach the sandbox provider's own creation-config/audit
surface (R6); every build-log line is sanitized before it's durable (R3.3); the dispatch
token is single-use and short-lived (R6.1).

**Reliability:** the checkpoint-push-then-destroy contract is the load-bearing guarantee
(R1.2, R2.3) — this is explicitly NOT thinned in v1, matching `runtime-substrate`'s "thin the
commodity assembly, never the safety guarantees" discipline. Stop is cooperative, never a
signal (R5). Staleness detection doesn't depend on web-tier process lifetime (R7).

**Isolation:** one build worker per build; v1 does not need to solve concurrent writers to
one workspace (the existing one-active-build-per-tenant admission model already prevents
this — R4.1 closes the one place that model is currently NOT enforced).

**Observability:** heartbeats (R7) + minimal cost tracking (R8) are in v1's scope, not
deferred — both are cheap additions once the dispatch/worker machinery exists, and both were
explicitly flagged as gaps in the *existing*, smaller-scope sandbox mechanism.

## Buy-vs-build
- **Object storage → BUY: Tigris** (S3-compatible, well-understood API; reachable from E2B
  sandboxes over their default outbound internet access). Same "buy the commodity, build the
  gate-gated glue" shape as `runtime-substrate`'s "frontend hosting → buy."
- **Ephemeral compute → BUY: E2B Sandboxes API**, purpose-built for exactly this spin-up/
  execute/teardown pattern, official TypeScript SDK (matches this codebase directly — no
  cross-language DX tax), no CLI-shell-out class of bugs. VibeHard's *existing* Fly-based
  sandboxing (`fly-exec-sandbox.ts`) stays exactly as-is for its own, narrower job
  (sandboxing the *generated app's* boot/build check inside `packages/gate-check`) — this is
  a new "buy" for the `BuildWorker` seam specifically, not a replacement of that mechanism.
- **BUILD (ours):** the `WorkspaceStore`/`BuildWorker` seams and their v1 implementations,
  the single dispatcher, the append-only log table + poll, the cooperative-stop mechanism,
  the scoped-token secrets callback, the heartbeat/orphan-sweep, minimal cost tracking, and
  the `pendingConfirm` fix. This is the majority of the work — the "buy" pieces (Tigris, E2B)
  are both already-proven-elsewhere commodities; the glue holding them together correctly
  (especially the checkpoint-then-destroy ordering) is where the real engineering is, same as
  `runtime-substrate`'s live-RLS probe was its one genuinely differentiated piece.

## Spike before building — ALL ITEMS CONFIRMED, 2026-07-10, live

All four Tier-0 items are now closed with real evidence, not inference. None required signup
for a paid tier or any resource left running afterward (a throwaway E2B sandbox pair and a
throwaway Tigris bucket were created, exercised, and fully destroyed; zero orphaned resources
confirmed via a post-test API list call on both providers).

1. **Tigris read/write/list from a real E2B sandbox — CONFIRMED.** Generated a synthetic
   ~11MB, 400-file tar inside a live sandbox (approximating a real generated-app workspace's
   shape, not one giant blob), pushed it to a real Tigris bucket via a presigned PUT, listed
   the bucket and confirmed the key was present, pulled it back via a presigned GET, and
   compared SHA-256 checksums — **byte-identical round-trip**. Real latency observed (single
   run, not a benchmark): PUT 635ms, LIST 214ms, GET 554ms for the 11MB tar. No S3 SDK needed
   inside the sandbox at all — plain `curl` against presigned URLs generated by the
   dispatcher, which is also the leanest shape for the real `BuildWorker` image.
2. **Nested sandbox creation from inside an already-ephemeral sandbox — CONFIRMED** (AC2.5).
   Originally scoped against Fly Machines; that spike hit CLI-layer friction (see SPEC's
   "Provider note"), which is what motivated re-scoping `BuildWorker` to E2B. Confirmed
   twice: once via a raw HTTP call (`POST`/`DELETE` against the control-plane API, no SDK, no
   CLI) and once via the full TypeScript SDK with `npm overrides` pinning a CJS-compatible
   `chalk` (see item 4).
3. **`DATABASE_URL` set in production — CONFIRMED** (`fly secrets list -a vibehard-platform`
   shows it deployed; checked name/digest only, never the value). Relevant to the *web
   tier's* own Fly hosting (unrelated to the `BuildWorker` provider swap) — still gates any
   later change to `min_machines_running`, which remains out of this epic's scope.
4. **Running an actual command inside a nested E2B sandbox — CONFIRMED.** The first attempt
   at this (during item 2's SDK-based test) hit a real but narrow issue: a live `npm install
   e2b` inside a running sandbox non-deterministically resolved a nested, nested-inside-e2b's-
   own-`node_modules` copy of `chalk` to an ESM-only v5+, which the SDK's own CJS bundle can't
   `require()`. Fixed by pinning `chalk` via npm's `overrides` field before installing — after
   that, sandbox A created sandbox B, ran `echo <marker>` inside B via the SDK's
   `commands.run()`, got the exact expected output back with exit code 0, and killed B
   cleanly. **This failure mode doesn't apply to the real `BuildWorker` design** (SPEC
   decision #2): the SDK ships baked into the custom template image at build time, with a
   real lockfile, not freshly `npm install`ed inside a live sandbox on every run — the
   non-determinism that caused this was an artifact of the spike's own test methodology
   (live install for a one-off check), not something the production design would ever hit.
5. **The real custom `BuildWorker` template — BUILT, REGISTERED, AND LIVE-CONFIRMED, 2026-07-11**
   (closing item 4's last caveat — the SDK is now genuinely baked in, not a hypothetical).
   `e2b.Dockerfile` (repo root) is a single-stage twin of the platform's own `Dockerfile`,
   forked for two real, E2B-specific incompatibilities discovered live (neither documented
   anywhere obvious beforehand):
   - **E2B's template builder rejects multi-stage Dockerfiles outright** (`Error: Multi-stage
     Dockerfiles are not supported`) — the platform `Dockerfile`'s `FROM flyio/flyctl:latest AS
     flyctl` / `COPY --from=flyctl` pattern for getting the `fly` binary had to become a
     single-stage `curl -L https://fly.io/install.sh | sh` instead.
   - **E2B's `COPY` doesn't auto-create destination directories the way Docker's does** — the
     platform Dockerfile's layer-caching trick (`COPY packages/gate-check/package.json
     packages/gate-check/` before the full `COPY . .`, so `bun install` isn't invalidated by
     unrelated source edits) failed with `failed to move files in sandbox: exit status 1`
     because `packages/gate-check/` didn't exist yet. Irrelevant for a template built once, not
     per-CI-run — collapsed to one `COPY . .` before `bun install`, sidestepping it entirely.

   Registered as template `vibehard-build-worker` (id `c9iv75vaji3nmn6opx4g`, E2B account
   `adammatar1982@gmail.com` / Default Team). **Live smoke test** (one real sandbox, created
   from this exact template, killed immediately after): confirmed `pwd` → `/app` and `whoami`
   → `user` (the sandbox's default cwd/user match the template's Docker `WORKDIR`/default user
   with zero extra wiring), `/app/src/cli.ts` present, `bun`/`node`/`npm`/`npx`/`flyctl`/`fly`/
   `semgrep`/`gitleaks`/`trivy` all resolve on `PATH`, and — the actual question this test
   existed to answer — the EXACT command `E2BBuildWorker` issues today, `bun src/cli.ts
   --version` (a **relative** path, per `CLI_PATH` in build-worker.ts), ran with exit 0 and
   printed the version. **Zero code changes needed to `build-worker.ts`** — its existing
   relative-path assumption was correct against the real template. Sandbox confirmed killed;
   zero orphaned sandboxes on the account afterward (`e2b sandbox list` → "No sandboxes found").
