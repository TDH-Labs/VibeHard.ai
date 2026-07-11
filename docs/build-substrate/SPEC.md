# Build Substrate — SPEC (intent)

> Stage 1 of 3 (spec → PRD → architecture). The grilled intent: *what* we're closing, *why
> now*, the scope, and the security posture. Authored as a VibeHard feature plan, using
> VibeHard's own front-half discipline — mirrors `docs/runtime-substrate/`'s three-file
> format for a different problem (that one is the post-gate deploy last-mile; this one is
> the pre-gate build-execution substrate). This closes EPIC #32 ("Build sandbox / per-build
> isolation," `in_progress`), which had no formal design doc anywhere in the repo until now.

## One-liner
Move the platform's **own** build/fix execution off the shared web-serving host onto
**ephemeral, per-build compute**, with the tenant workspace made durable via **object
storage** instead of local disk — closing both "build compute runs on the machine serving
web traffic" and "a workspace only survives on whichever single machine last touched it."

## Why now (the gap it closes)
A 2026-07-08/09 dogfooding incident found the tenant workspace tree
(`~/.vibehard/tenants/<id>/apps/<app>/`) living on local disk with no shared storage: a
routine deploy wiped an in-progress build, and — worse — under 2 machines, two Fly instances
held **different file sets for the same app** (confirmed live: machine A had the full source
tree, machine B a different partial one). The acute symptom was patched same-week with a
single Fly Volume (`fly.toml`, commit `b8ec05e`) pinned to `min_machines_running = 1` — but
`docs/ROADMAP.md` says outright this must be "re-open[ed] before scaling past one machine,"
and ties the real fix directly to EPIC #32: "the sandbox work should settle this as part of
defining where a build's workspace actually lives."

EPIC #32 already shipped real, live, production-proven sandboxing (`src/substrate/
fly-sandbox.ts`, `fly-exec-sandbox.ts` — confirmed via a real SSH smoke test the same night
this doc was written) — but only for the **verify gate's check of the generated app's own
boot/build**, and it shells out to the `fly` CLI as a subprocess rather than calling an SDK.
The platform's **own** `bun src/cli.ts build/fix` invocation — the thing that actually needs
isolating — still runs as a raw `Bun.spawn` directly inside `web/server.ts`'s request handler,
on the same machine serving web traffic. Everything shipped since (the cross-process host-lock
mutex, the whole-platform concurrency cap) is contention management on ONE shared box, not
isolation.

**Provider note (2026-07-10):** a live spike attempting to validate nested ephemeral-machine
creation against Fly's Machines API hit repeated, largely self-inflicted CLI-layer friction
(a convenience image's baked-in `ENTRYPOINT` silently swallowing command overrides, `exit_code
=-1` restart-loops, `--detach`/`--no-tail` not behaving as documented) — not evidence the
underlying mechanism doesn't work (it does; that's exactly what `fly-exec-sandbox.ts` already
proves live), but evidence that *scripting a CLI* is inherently more brittle than *calling an
SDK*. **`BuildWorker`'s v1 implementation targets E2B (e2b.dev) instead of Fly Machines** —
purpose-built for exactly this ephemeral spin-up/execute/teardown pattern, with an official
TypeScript SDK (no CLI-shell-out class of bugs at all). This is a swap of the `BuildWorker`
seam's v1 implementation only — VibeHard's *existing* Fly usage (the platform's own hosting,
and `runtime-substrate`'s `FlyHostProvider` for deploying *finished, gated* generated apps to
production) is unrelated and untouched by this decision.

Separately, VibeHard is scoping a Phase II "Enterprise Agent Builder" direction (`docs/
ROADMAP.md`) that reuses this same orchestrator/build substrate for **long-running agents**,
not one-shot builds. Whatever closes this gap needs to decouple compute from state from the
start — a pinned machine per build doesn't extend to an agent whose lifetime isn't bounded
by one HTTP request.

## Users
- **The platform itself.** No end-user-visible UX change in v1 — the same chat/status/build
  UX, structurally isolated underneath. (Primary — this is infrastructure, not a feature.)
- **Phase II's future Agent Runtime** — the structural beneficiary. Compute/state decoupling
  built here is exactly what a long-running agent needs; not built for Phase II directly.

## Decisions from review (load-bearing — each closes a specific failure mode found during research)
1. **Object storage (Tigris — a well-understood, S3-compatible store) is the workspace source
   of truth**, not a shared/synced Fly Volume, not sticky routing, not a pool of pinned
   long-lived workers. An ephemeral build worker is by definition not sticky to anything —
   sticky routing solves a *different*, now-moot problem (pinning HTTP requests to one web
   machine). The **pinned-long-lived-worker pool was explicitly considered and rejected**:
   it reuses more existing code untouched, but it doesn't decouple compute from state — the
   opposite of what Phase II needs. E2B sandboxes have outbound internet access by default, so
   Tigris is reachable from the worker regardless of compute provider — this decision no
   longer carries a same-cloud/zero-egress rationale (that was Fly-specific), just "well-
   understood S3 API, buy don't build," the same shape as `runtime-substrate`'s "frontend
   hosting → buy."
2. **The build worker runs the platform's own pre-built image, as an E2B custom template**
   (built once from the root `Dockerfile` — bun, node22, semgrep/gitleaks/trivy already baked
   in — via E2B's Dockerfile-based template system), with the tenant workspace pulled in as
   **data** at startup — NOT `fly-exec-sandbox.ts`'s existing mechanism of building a fresh
   Docker image from the target workspace on every call. That mechanism is correct for its
   actual job (sandboxing a small, arbitrary *generated app's* build) and stays unchanged; it
   would be the wrong shape for running the platform's own large, stable toolchain repeatedly
   even if it were reused as-is.
3. **Checkpoint granularity is per autofix iteration**, not per pipeline stage and not per
   whole autofix loop. A real build runs 45+ minutes across multiple gate→fix→re-gate
   iterations burning real LLM spend (confirmed via the ROADMAP's own dogfooding logs) —
   losing a whole loop to one dead worker is wasted money, not just wasted time.
4. **Checkpoint-push-then-destroy, strictly ordered, fail closed.** The push is retried with
   backoff; a push that can't complete **holds the build** rather than proceeding to
   teardown. This is the exact shape of bug ("state assumed durable, wasn't") that caused
   the original incident, one layer down — it does not get the same best-effort treatment
   `fly-exec-sandbox.ts`'s own teardown correctly uses for a genuinely throwaway machine.
5. **One dispatcher replaces both existing local-spawn call sites** — `web/server.ts`'s
   `buildStream()` (the primary path: `/api/build`, `/api/redeploy`, `/api/polish`,
   `/api/change`, `/api/rollback`) and `src/orchestrator-glue/build-tools.ts`'s
   `realBuildTools().retry()` (the chat-driven path) both collapse onto "dispatch a build
   worker, tail the durable log." The chat path gains the `isBuildRunning`/`atBuildCapacity`
   admission check it is missing today — closing a real, already-live race: `retry()`
   currently spawns unconditionally and `/api/orchestrator/message` never checks build
   status before calling `Orchestrator.onMessage()`, so a chat "retry" during an in-flight
   SSE-driven build can spawn a second, conflicting process against the same directory today.
6. **Stop becomes cooperative, not `SIGKILL`.** A durable stop-flag the worker polls between
   internal steps replaces `/api/build/stop`'s current `running.get(tenantId)?.kill()`, which
   has no meaning once the process isn't a local child handle.
7. **Live logs are an append-only table, not a reuse of the existing durable-blob pattern.**
   Every other durable seam in this codebase (`secrets.ts`, `record.ts`,
   `PgBuildProgressStore`) stores one opaque JSON blob per `(scope)` key, full-value
   overwrite on every write — correct for a handful of proactive messages, wrong for a build
   log that can be thousands of lines: reusing that shape means every log line triggers a
   full read-modify-write of the growing blob. A plain `INSERT`-and-delta-poll table is the
   fix, and it comes with a real side benefit: it also closes the *existing* bug where a
   browser refresh mid-build shows "still working, can't watch it live" with zero log
   history — last-seen-position replay falls out of the same design for free.
8. **Secrets reach the worker via a scoped, single-use, expiring token minted at dispatch
   time** — the worker calls back to an internal platform endpoint to fetch its env, rather
   than tenant secrets (a Supabase service-role key, a BYO LLM key) ever being passed directly
   as sandbox creation env vars (E2B's `Sandbox.create({ envs })`), which — like Fly's `--env`/
   `fly secrets set` — isn't confirmed to avoid leaving a trace in the provider's own
   dashboard/audit surface. This is a materially higher-stakes secret than the single
   `E2B_API_KEY` the nested-sandbox mechanism itself needs (decision below) — it needs its own
   explicit answer, not the same treatment by default.
9. **Heartbeat-based staleness/orphan detection**, not `sweepStaleRunning()`'s current
   inference ("the web process just booted, so any 'running' record must be stale") — that
   inference becomes wrong in both directions once the build subprocess isn't the web
   process's own child: a worker can die silently while the web tier runs for weeks
   (nothing ever notices, the tenant's admission-control slot stays permanently occupied),
   and a web-tier redeploy no longer implies anything about a live worker. Plus an
   independent periodic sweep for orphaned build-worker E2B sandboxes as a backstop — E2B
   sandboxes already carry their own `timeoutMs` auto-expiry (confirmed: `Sandbox.create`'s
   default timeout kills an abandoned sandbox even if nothing ever calls teardown), which is a
   real safety net Fly's exec-sandbox pattern didn't have as cleanly — but don't rely on that
   alone; the sweep is still the thing that closes the "nothing ever notices" admission-control
   gap.
10. **Minimal per-build compute cost tracking is in this epic's scope, not deferred to EPIC
    #37.** Nested sandboxing (the platform's own `verify` gate calling a sandboxed exec *from
    inside* a build worker) compounds real spend across two layers — track both, not just the
    outer one.

**Shipped separately, unblocked by the rest:** `Orchestrator.pendingConfirm` (the yes/no gate
before "ship") lives in an in-process `Map` today — a latent, independent bug on the
*existing* multi-machine web tier, unrelated to build compute. Cheap, separable, doesn't wait
on anything above.

## In scope (v1 — the walking skeleton)
- `WorkspaceStore` seam + one Tigris implementation: whole-tree tar pull at worker start,
  push at each checkpoint.
- `BuildWorker` seam + one E2B sandbox implementation, running the platform's own custom
  template image.
- One dispatcher, replacing both existing local-spawn call sites, carrying the missing
  admission check.
- Durable append-only live build log + SSE poll-and-tail with reconnect replay.
- Cooperative stop (durable poll-flag).
- Scoped, single-use, expiring token for secrets propagation to the worker.
- Heartbeat-based staleness detection + an independent orphan-worker sweep.
- Minimal per-build cost tracking (at minimum: compute-seconds consumed, surfaced somewhere
  durable — not a full cost-governance dashboard).
- `Orchestrator.pendingConfirm` durability fix (separate workstream, no dependency on the rest).

## Out of scope (v1 — captured, not now; build once there's real multi-machine scaling demand)
- Incremental/fine-grained workspace sync (only whole-tree tar for v1).
- A second `WorkspaceStore`/`BuildWorker` provider.
- Concurrent writers to one workspace (v1 keeps the existing one-active-build-per-tenant
  admission model — no new coordination needed).
- Full cost *governance* (budgets, alerting, per-tenant billing tie-in) — EPIC #37's scope;
  this epic ships only the minimal tracking named above.
- Cloud-KMS-backed secrets generally — EPIC #35's scope; this epic's scoped-token design for
  worker secrets propagation is adjacent to, not a replacement for, that epic.
- Relaxing `fly.toml`'s `min_machines_running = 1` for the *web* tier — a real question once
  the web tier no longer needs local tenant-workspace disk, but gated on confirming
  `DATABASE_URL` is actually set in production (the Dockerfile's embedded-pglite fallback
  also lives on the same volume mount — don't assume it's unused).

## Data + security posture
- **Tenant secrets never appear in the sandbox provider's own creation-config/audit surface.**
  The worker fetches its env via a scoped, single-use, expiring token minted at dispatch
  (decision #8) — not passed directly as sandbox-creation env vars.
- **Workspace content in object storage is the SAME data that's on local disk today** (source
  code, `.vibehard/spec.json`, generated app files) — no NEW class of sensitive data is
  introduced by moving it to Tigris; classification/rigor is unchanged. Standard "credentials
  → production rigor" data-classification discipline (matching `runtime-substrate`'s own
  posture) applies to the scoped dispatch tokens themselves.
- **No secret is ever logged** — the durable build-log table is USER-FACING build output
  (npm/gate/LLM step logs), and must go through the same sanitization discipline already
  applied to `web/server.ts`'s existing SSE pump (§21) before landing in the new table, not a
  new, unreviewed logging path.

## Invariants (non-negotiable)
- **Checkpoint-push-then-destroy is strictly ordered and fails closed** — a build worker
  never tears itself down before its last checkpoint push has succeeded (decision #4).
- **Stop is cooperative, never a signal** — no mechanism in this design sends a kill signal
  to a build worker; it can only be asked to stop and choose when to yield.
- **One active build per tenant, enforced at dispatch** — the new dispatcher checks the same
  admission control both existing call sites should already have, closing the live race
  found in decision #5, not just moving it.
- **Zero LLM in the dispatch/storage/checkpoint path itself** (§11 discipline, unchanged) —
  the LLM calls happen exactly where they do today, *inside* the worker's own `cli.ts`
  execution; nothing about moving where that execution runs adds a new LLM call to the
  control plane.
- **Nested sandbox calls require `E2B_API_KEY` threaded to the worker** — the platform's own
  `verify` gate calls a sandboxed exec from inside the pipeline; once that pipeline itself
  runs inside a build worker, the key must reach two layers deep, not one. **Confirmed live,
  2026-07-10**: a real E2B sandbox, given the API key in its own env, successfully created a
  second, independent sandbox via a plain HTTP call to E2B's control-plane API from code
  running inside it, then tore that second sandbox down — the exact nested pattern this
  invariant depends on. No orphaned sandboxes remained afterward. This is not an inference
  from documentation; it's a live-tested fact.

## Success = a build survives the machine it started on
A build that's mid-flight when its worker dies (crash, OOM, a platform deploy) is recoverable
from its last checkpoint, not lost — with no cross-machine split-brain (the 07-08/09 incident
does not recur), no SIGKILL-based stop, and no silent orphaned sandbox spend — while the
browser-facing chat/status/live-log experience is unchanged from today's.
