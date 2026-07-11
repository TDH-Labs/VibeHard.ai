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

### R2 — `BuildWorker` seam + ephemeral-Fly implementation
Dispatch one ephemeral Fly machine per build, running the platform's own pre-built image
(not a per-invocation image build from the workspace — see SPEC decision #2). The machine
pulls the workspace (R1), runs the unmodified `bun src/cli.ts build/fix <dir>` pipeline
against local disk exactly as today, checkpoints per autofix iteration (not per stage, not
per whole loop), and is always torn down — success, failure, or stop.
- **AC2.1** A build that completes normally leaves the worker torn down and the final
  workspace state pushed to `WorkspaceStore`.
- **AC2.2** A build worker killed mid-iteration (simulated: `fly machine destroy --force`
  during a run) leaves the workspace at its LAST successfully pushed checkpoint, not an
  earlier or later state, and a subsequent `retry` (R4) resumes from exactly that point.
- **AC2.3** The worker's own teardown never runs before its final checkpoint push has
  succeeded or exhausted retries (R1.2) — verified by a fault-injection test that fails the
  push and confirms the machine is NOT destroyed.
- **AC2.4** A build worker crash that prevents even a final checkpoint push (hard OOM, host
  eviction) does not leave an orphaned Fly app running indefinitely — closed by R7's sweep,
  not by this requirement's own machinery.

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
minted at dispatch time, calling back to an internal platform endpoint — never via `fly
secrets set` or `--env` on `fly machine run`.
- **AC6.1** The token is usable exactly once (or until a short TTL expires, whichever first)
  — a captured token can't be replayed against a later dispatch.
- **AC6.2** No tenant secret (LLM key, integration key, Supabase service-role key surfaced
  via a gate/deploy step) appears anywhere in Fly's own machine-config or API-visible
  metadata for the ephemeral app.
- **AC6.3** The callback endpoint itself is scoped to return ONLY the secrets for the one
  build the token was minted for — never a broader tenant secret set.

### R7 — Heartbeat-based staleness + orphan sweep
Replace `sweepStaleRunning()`'s "web process just booted" inference with a heartbeat the
worker writes on an interval; a periodic, independent sweep flags/destroys Fly apps whose
worker hasn't heartbeat in N minutes.
- **AC7.1** A build whose worker died silently (no clean teardown) is detected as stale
  within a bounded window (not "only on the next web-tier redeploy," which may be days).
- **AC7.2** A build that's genuinely still running for 45+ minutes (a real observed duration)
  is NOT falsely flagged stale — the heartbeat interval and staleness threshold are chosen
  with real build duration data, not an arbitrary short window.
- **AC7.3** An orphaned build-worker Fly app (heartbeat stopped, no clean teardown) is
  destroyed by the sweep within a bounded window, independent of any one machine's own
  `finally`-block cleanup succeeding.

### R8 — Minimal per-build cost tracking
At minimum, record Fly machine-seconds consumed per build (including nested exec-sandbox
machines spawned by the platform's own `verify` gate running inside a worker).
- **AC8.1** Every build's cost record is queryable after the fact (even if only a raw
  machine-seconds number, not a dollar figure) — not zero visibility, matching the existing
  gap ROADMAP.md already flags as "no cost tracking/alerting" on the current single layer.
- **AC8.2** Nested sandbox spend (verify gate's own exec-sandbox calls, run from inside a
  build worker) is attributed to the SAME build's cost record, not lost as a second,
  invisible layer.

### R9 (separate, unblocked by R1–R8) — `Orchestrator.pendingConfirm` durability
Move the pending-confirm slot (the yes/no gate before "ship") from `Orchestrator`'s
in-process `Map` into the same durable per-tenant store already used for the outbound inbox.
- **AC9.1** A "ship" proposal and its "yes" confirmation land correctly even when routed to
  two different web-tier machines by the load balancer — no silent re-classification of
  "yes" as a fresh, unrelated message.

## Non-functional requirements (NFRs)

**Security:** tenant secrets never reach Fly's own machine-config/audit surface (R6); every
build-log line is sanitized before it's durable (R3.3); the dispatch token is single-use and
short-lived (R6.1).

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
- **Object storage → BUY: Tigris** (Fly-native, S3-compatible, zero egress cost from Fly
  compute). Same "buy the commodity, build the gate-gated glue" shape as
  `runtime-substrate`'s "frontend hosting → buy."
- **Ephemeral compute → BUY: Fly Machines API**, already proven live via
  `fly-exec-sandbox.ts`'s existing pattern — extending its scope, not replacing its
  mechanism.
- **BUILD (ours):** the `WorkspaceStore`/`BuildWorker` seams and their v1 implementations,
  the single dispatcher, the append-only log table + poll, the cooperative-stop mechanism,
  the scoped-token secrets callback, the heartbeat/orphan-sweep, minimal cost tracking, and
  the `pendingConfirm` fix. This is the majority of the work — the "buy" pieces (Tigris, Fly
  Machines) are both already-proven-elsewhere commodities; the glue holding them together
  correctly (especially the checkpoint-then-destroy ordering) is where the real engineering
  is, same as `runtime-substrate`'s live-RLS probe was its one genuinely differentiated piece.

## Spike before building (de-risk the design's assumptions)
1. **Tigris read/write/list from a real Fly machine** — confirm the actual API surface,
   auth model, and round-trip latency for a whole-tree tar of realistic size (a generated
   Next.js app + `node_modules` is not small).
2. **Nested `fly machine run` from inside an already-ephemeral Fly machine** — the platform's
   own `verify` gate already calls `runInFlyExecSandbox`; once that pipeline itself runs
   inside a build worker, this becomes a genuinely new, never-exercised call pattern (a Fly
   machine spinning up another Fly machine). Confirm it actually works before the ARCHITECTURE
   doc's dependency graph assumes it does.
3. **Confirm `DATABASE_URL` is set in production**, not assumed — the `Dockerfile`'s
   embedded-pglite fallback also lives on the same volume mount `fly.toml` currently pins to
   one machine; any later change to `min_machines_running` needs this confirmed first, even
   though it's explicitly out of scope for this epic itself (SPEC "Out of scope").
