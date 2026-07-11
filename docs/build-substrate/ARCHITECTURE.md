# Build Substrate — ARCHITECTURE (technical design)

> Stage 3 of 3. The PRD's requirements turned into components, the seams they sit behind,
> the dependency graph that orders the build, and the v1-vs-later split. Mirrors VibeHard's
> existing patterns (the `HostProvider`/`SecretsStore`/`BackendProvider` seams in
> `src/substrate/types.ts`; the gate sentinel precondition; `fly-exec-sandbox.ts`'s proven
> always-torn-down teardown discipline, applied to a new provider — see SPEC's "Provider
> note" for why `BuildWorker`'s v1 implementation targets E2B rather than Fly Machines).

## Shape
A dispatcher replaces two existing local-spawn call sites; each build runs on its own
ephemeral **`BuildWorker`**, pulling/pushing state through **`WorkspaceStore`**, writing to a
durable **log table**, and checkpointing on a strict push-then-destroy contract:

```
[chat "retry" OR /api/build /api/redeploy /api/polish /api/change /api/rollback]
        ▼
dispatch(tenantId, app, mode)                        ← THE dispatcher (new; replaces both
  1. isBuildRunning(tenantId)?  → refuse/queue          buildStream()'s inline spawn AND
  2. atBuildCapacity()?         → 503, unchanged          realBuildTools().retry()'s spawn)
  3. mint a scoped, single-use, expiring secrets token
  4. BuildWorker.dispatch(tenantId, app, mode, token)  ← ephemeral E2B sandbox, platform's
                                                           own pre-built custom-template
                                                           image (NOT a per-invocation
                                                           image build)
        ▼  (on the worker, inside its own sandbox)
  5. WorkspaceStore.pull(tenantId, app) → local tmpdir  ← whole-tree tar from Tigris
  6. fetch env via the one-time token                  ← R6; never passed as sandbox-
                                                           creation env vars directly
  7. run `bun src/cli.ts build/fix <dir>` UNMODIFIED    ← same pipeline as today, same LLM
     — per AUTOFIX-ITERATION (not per stage, not per      calls, same gates (incl. nested
       whole loop):                                       sandboxed exec — needs
       a. tee build-log lines → build_log_lines table      E2B_API_KEY threaded here too,
       b. write heartbeat                                  CONFIRMED WORKING live 2026-07-10)
       c. check stop-flag → cooperative yield if set
       d. WorkspaceStore.push(checkpoint tar)            ← retried w/ backoff; FAILS CLOSED
                                                             (hold the build, do NOT destroy)
  8. on terminal state (done/held/stopped/error):
       final WorkspaceStore.push() → MUST succeed before step 9
  9. BuildWorker teardown (always — win, lose, or die)   ← same discipline as
                                                             fly-exec-sandbox.ts today,
                                                             backstopped by E2B's own
                                                             timeoutMs auto-expiry

[independently, always running]
heartbeat sweep       → flags a worker stale after N minutes of silence (R7)
orphan sweep          → destroys a sandbox whose worker went stale with no clean teardown
cost tracker          → compute-seconds per build, incl. nested sandbox spend (R8)
```

The **web tier's SSE endpoint never spawns or pipes anything** post-migration — it polls
`build_log_lines` for new rows past the client's last-seen `seq` and forwards them, and polls
`BuildProgressStore`/heartbeat state for status. This is what makes reconnect-replay fall out
for free (R3.1) and what removes the co-location assumption `pump()` has today.

## Components / workstreams

- **W1 `WorkspaceStore` (seam) + `TigrisWorkspaceStore` (impl).** `pull(tenantId, app) →
  localDir` (tar-extract), `push(tenantId, app, localDir)` (tar-create, upload). Whole-tree
  only in v1 — no incremental diffing. Seam lets a second provider drop in later (mirrors
  `HostProvider`'s "one impl for v1, alternates only on concrete need" discipline already
  used throughout `src/substrate/`).
- **W2 `build_log_lines` table + poll-tail SSE.** `insert into build_log_lines (scope, seq
  bigserial, line, at) ...`; the worker's tee does a plain `INSERT` (O(1), no
  read-modify-write); the SSE endpoint does `select ... where scope=$1 and seq > $lastSeq
  order by seq limit 500` on a sub-second interval. Deliberately NOT the `tenantKv`
  blob-overwrite shape (`PgTenantKvStore`'s `insert ... on conflict (scope, k) do update`) —
  that pattern is correct for the outbound inbox (a handful of proactive messages) and wrong
  for a growing multi-hundred-line log.
- **W3 `BuildWorker` (seam) + E2B sandbox impl.** `dispatch(tenantId, app, mode, secretsToken)
  → workerId`; internally: pull workspace (W1), fetch env via the token (W5), run the
  unmodified `cli.ts build/fix` pipeline, tee to W2, checkpoint per autofix iteration,
  push-then-destroy (never the reverse order). Runs the **platform's own root `Dockerfile`,
  built once as an E2B custom template**, not a fresh per-call image build — the one
  deliberate mechanical difference from `fly-exec-sandbox.ts`'s existing pattern, which stays
  exactly as-is for its own job (sandboxing the *generated app's* boot/build check inside
  `packages/gate-check`) and on its own provider (Fly). **Nested sandbox creation confirmed
  live 2026-07-10**: code running inside an E2B sandbox, given the API key in its own env,
  created a second sandbox via a plain `fetch()` POST to `https://api.e2b.app/sandboxes`
  and deleted it via `DELETE .../sandboxes/{id}` — no SDK, no CLI, just the raw REST contract
  the SDK itself wraps (confirmed by reading the SDK's own source: `POST /sandboxes`, header
  `X-API-Key`, default `templateID: "base"`). Zero orphaned sandboxes after. Re-confirmed a
  second way via the full SDK (`commands.run()` on the nested sandbox executed a real
  command and returned the exact expected output, exit code 0) — this is exactly the
  mechanism the platform's own `verify` gate needs when its sandboxed-exec call runs from
  inside a `BuildWorker`.
- **W4 The dispatcher.** The single new entry point both `web/server.ts`'s `buildStream()`
  and `src/orchestrator-glue/build-tools.ts`'s `realBuildTools().retry()` call instead of
  their current independent `Bun.spawn(["bun", CLI, ...])` calls. Carries the
  `isBuildRunning`/`atBuildCapacity` admission check to the chat path, which is missing it
  today (the confirmed-live race — R4.1). `realBuildTools().status()`/`.why()`/`.ship()`
  read from durable state (W2's log table + `BuildProgressStore`) instead of local `diagnose(dir)`
  reads; `.setModel()`'s `process.env` write is replaced with a durable per-build override
  the next dispatch reads (today's version only affects the calling process's own future
  spawns, which is already subtly wrong on the current multi-machine web tier — fixed as a
  side effect of this migration, not a separate requirement).
- **W5 Cooperative stop + scoped secrets token.** A durable stop-flag (`BuildProgressStore` or
  a sibling table) the worker checks between internal steps, replacing `/api/build/stop`'s
  `running.get(tenantId)?.kill()`. A short-lived, single-use token minted at dispatch time,
  checked by an internal-only endpoint the worker calls to fetch its env — the SAME env
  `buildStream()` already assembles in-process today (tenant BYO LLM key, integration keys,
  steering), just fetched remotely instead of inherited from the spawning process.
- **W6 Heartbeat + orphan sweep + cost tracking.** The worker writes a heartbeat on an
  interval (durable, e.g. alongside `BuildProgressStore`'s existing per-tenant record); a
  periodic sweep (independent of any one machine, e.g. a scheduled job or a check-on-read
  pattern matching `sweepStaleRunning()`'s existing role) flags/destroys stale workers and
  their sandboxes — backstopped, not replaced, by E2B's own `timeoutMs` auto-expiry on the
  sandbox itself. Cost: at minimum, compute-seconds per build, attributing nested sandbox
  spend (the `verify` gate's own sandboxed-exec calls, now running *inside* a worker) to the
  same build's record — not a second, invisible spend layer.
- **W7 `Orchestrator.pendingConfirm` durability.** Move the private `pendingConfirm` field
  (`packages/orchestrator/src/orchestrator.ts:105`) into the same durable per-tenant store
  pattern already proven for the outbound inbox. **Parallel workstream — no dependency on
  W1–W6, ships independently.**

## Dependency graph → build order (topological tiers)

```
Tier 0 (SPIKE — ALL 4 ITEMS        Tigris read/write/list from a real E2B sandbox — CONFIRMED
        CONFIRMED 2026-07-10,      (byte-identical SHA-256 round-trip on an 11MB/400-file
        live, before any build):  synthetic workspace tar; PUT 635ms/LIST 214ms/GET 554ms) ·
                                   nested E2B sandbox creation from inside an already-
                                   ephemeral sandbox — CONFIRMED (raw HTTP AND full SDK) ·
                                   running an actual command inside that nested sandbox —
                                   CONFIRMED (chalk/npm-overrides fix; the underlying
                                   non-determinism was a spike-methodology artifact, doesn't
                                   apply to the real pinned-template design) · DATABASE_URL
                                   actually set in production — CONFIRMED (relevant to the
                                   web tier's own Fly hosting, unrelated to the BuildWorker
                                   provider swap; still gates any later change to
                                   min_machines_running, out of this epic's own scope).
                                   Zero orphaned resources left on any provider afterward.

Tier 1 (independent foundations,   WorkspaceStore(W1) · build_log_lines table(W2) ·
        parallel):                 stop-flag + heartbeat fields on BuildProgressStore(part
                                   of W5/W6) · pendingConfirm fix(W7, fully independent)

Tier 2:                            BuildWorker seam + impl(W3) — depends on W1 (pull/push)
                                   and W2 (log tee target) existing

Tier 3:                            the single dispatcher(W4) — depends on W3 existing;
                                   scoped-token secrets callback(W5) — depends on W3's
                                   dispatch call needing something to mint/check

Tier 4:                            heartbeat/orphan sweep + cost tracking(W6) — depends on
                                   W3 workers actually existing to monitor; cutover (retire
                                   both old local-spawn call sites once W4 is live and
                                   verified against real builds)

Tier 5 (deliberately NOT in this   revisit fly.toml's min_machines_running=1 / single-
        epic's build order):       machine constraint for the WEB tier now that it no
                                   longer needs local tenant-workspace disk — gated on the
                                   Tier-0 DATABASE_URL confirmation; cross-references EPIC
                                   #35 (KMS) and EPIC #37 (cost governance) below.
```

Same `buildOrder`-style topological plan the front-half produces for generated apps —
applied to VibeHard's own build-execution substrate, same discipline `runtime-substrate`
used for its own tiers.

## v1 = the WALKING SKELETON (same discipline `runtime-substrate` used)
Building the thinnest thing that proves "a build survives the machine it started on"
end-to-end, behind clean seams, before hardening further:

- **In v1:** the seam *interfaces* + **single happy-path impls** — Tigris only, one E2B
  `BuildWorker` impl, whole-tree tar (no incremental sync), one active build per tenant (no
  concurrent-writer coordination), checkpoint per autofix iteration, minimal (not full) cost
  tracking.
- **"Thin" applies to the COMMODITY assembly — NOT the safety guarantees.** The
  checkpoint-push-then-destroy ordering (decision #4/AC2.3), cooperative stop (never a
  signal), and the scoped single-use secrets token are real and non-negotiable even in the
  skeleton — exactly matching `runtime-substrate`'s "thin the commodity assembly, never the
  live-RLS probe" precedent. These are the differentiated, load-bearing parts.
- **Deferred until real multi-machine scaling demand:** incremental/fine-grained workspace
  sync, a second `WorkspaceStore`/`BuildWorker` provider, concurrent-writer handling for one
  workspace, full cost *governance* (EPIC #37), cloud-KMS-backed secrets generally (EPIC
  #35 — this epic's scoped-token design is adjacent, not a replacement).

## Determinism / seam notes
- **Zero LLM in the dispatch/storage/checkpoint control plane** (§11, unchanged) — the LLM
  calls happen exactly where they already do, inside the worker's own `cli.ts` execution.
  Moving *where* that execution runs adds no new LLM call to anything that decides
  dispatch/checkpoint/teardown.
- **Two swappable seams** (`WorkspaceStore`, `BuildWorker`) — same discipline as
  `HostProvider`/`SecretsStore`/`BackendProvider` in `src/substrate/types.ts`: one impl each
  for v1, a second only on concrete need, unit-tested with fakes (no real Tigris/E2B calls
  in the test suite — matching how `fly-sandbox.ts`/`fly-exec-sandbox.ts` are already tested
  today). The seam is what made the Fly→E2B provider swap cheap: only W3's implementation
  and the handful of Fly-specific mentions in this doc set changed — the shape of every other
  workstream (W1, W2, W4, W5, W6, W7) was untouched by the swap.
- **Idempotency is keyed on the checkpoint**, not on probing the worker — a `retry` after a
  dead worker resumes from the last successfully pushed tar, the same idempotency shape
  `runtime-substrate`'s `DeploymentRecord` already established for a different resource.
- **The dispatcher is the ONE place admission control is enforced** (`isBuildRunning`/
  `atBuildCapacity`) — both existing call sites currently duplicate (correctly, for HTTP) or
  omit (incorrectly, for chat) this check; collapsing onto one dispatcher removes the
  omission as a structural possibility, not just a fixed instance.

## What this does NOT include (boundaries restated)
- **The pinned-long-lived-worker-pool alternative** — considered and rejected (SPEC decision
  #1). It reuses more of today's local-disk code unmodified, but doesn't decouple compute
  from state, which is the entire point for Phase II's long-running-agent shape. Recorded
  here explicitly so it isn't re-proposed fresh without this context.
- **EPIC #35 (Secrets via KMS)** — this epic's scoped-token design solves *worker secrets
  propagation* specifically; it is not a general KMS migration for the platform's other
  secret stores (`SecretsStore` in `src/substrate/`, `tenantKv`'s encrypted values). Adjacent
  surface, separate epic.
- **EPIC #37 (Cost governance + observability)** — this epic ships only R8's minimal
  compute-seconds tracking, not budgets, alerting, or per-tenant cost attribution to billing.
- **Relaxing `fly.toml`'s single-machine pin for the web tier** — a real, separate follow-on
  decision once this epic's workspace-off-local-disk change actually lands, gated on
  confirming the `DATABASE_URL`/embedded-pglite dependency on the same volume mount is clear
  (Tier 0 spike, PRD §3) — not decided or executed as part of this doc set.
- **The front-door UI, the AI Maintainer** — unrelated, per `docs/ROADMAP.md`'s existing
  boundary language (same exclusions `runtime-substrate/ARCHITECTURE.md` already states).
