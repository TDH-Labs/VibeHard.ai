# Failure-class ledger

The unknown-unknowns discovery mechanism (Phase 2). Every never-seen-before failure class from a
benchmark run becomes: (a) an entry here, (b) a minimal repro, and (c) either a template fix, a
deterministic check, or a new eval case. Append-only; classes are closed by naming the commit that
locks them with a test. The benchmark score (`vibehard benchmark`) is the only progress metric.

Format per entry:

```
## <class-slug>
- first seen: <date> · <run/build id> · <case id>
- symptom: what the run actually showed (gate + finding, verbatim where possible)
- root cause: from direct evidence, reproduced in isolation where possible
- fix: <layer that owns the decision> · <commit> · locked by <test>
- status: open | fixed | superseded-by <class>
```

---

## boilerplate.supabase-on-client-only
- first seen: 2026-07-11 · live pomodoro builds · pomodoro-timer
- symptom: architecture forced Supabase onto a client-only app; fix loop re-introduced it independently.
- root cause: no third option between "must use Supabase" and "local tool"; every codegen-capable site defaulted to Supabase.
- fix: architecture checks + shared NO_BACKEND_INSTRUCTION · dd85f3d, 41a663e, eb932d8, 13c39df · architecture/spec-review tests
- status: fixed (structurally superseded by golden templates, 3df3a19)

## boilerplate.missing-manifest
- first seen: 2026-07-12 · live build · pomodoro-timer
- symptom: no workstream ever assigned package.json; nothing installable.
- root cause: plans validated per-workstream, never as a whole.
- fix: no-project-manifest check · 1852282 · architecture.test.ts
- status: fixed (inverted under templates: template owns the manifest, 3df3a19)

## boilerplate.missing-root-layout
- first seen: 2026-07-12 · live build · pomodoro-timer
- symptom: app/ pages planned with no app/layout.tsx; Next build ENOENT.
- root cause: framework-required entry point not part of any plan check.
- fix: no-root-layout check · fd06a7a · architecture.test.ts
- status: fixed (inverted under templates, 3df3a19)

## boilerplate.tailwind-version-misdetect
- first seen: 2026-07-12 · live builds (several CSS failures) · pomodoro-timer
- symptom: v3 apps configured as v4 (and v4's postcss plugin never installed).
- root cause: detection regex was always-true for every input.
- fix: scaffoldConfigs rewrite · cc4170b · cli.test.ts
- status: fixed (templates pin Tailwind v3 exactly, 3df3a19)

## codegen.empty-workstream-silent-pass
- first seen: 2026-07-13 · /tmp/debug-e2e-9 · pomodoro-timer
- symptom: "Project Setup — 7 file(s)" streamed zero file actions and no error; proptest then
  reported "the app has no package.json"; 45 minutes of fix-loop improvisation → held.
- root cause: a model response with no parseable file actions yields no error event; nothing
  validated what codegen DELIVERS against what the plan ASSIGNS.
- fix: per-workstream post-condition (retry once, then abort) · 1af75bc · cli.test.ts (missingWorkstreamFiles)
- status: fixed

## deploy.port-contract-unenforced
- first seen: 2026-07-13 · /tmp/debug-e2e-9 · pomodoro-timer
- symptom: verify sandbox-boot-failed 502 across 4+ fix attempts; app healthy when booted with
  PORT=8080 by hand (reproduced in isolation 2026-07-17).
- root cause: fly.toml routes to internal_port 8080 but PORT was never injected; the finding
  never named the contract, so the fixer oscillated blind. Same latent bug in the local docker
  probe (later -e PORT overrides the pin).
- fix: substrate pins PORT=internalPort; containerRunArgs filters app PORT; finding states the
  contract · 0e16c7c · fly.test.ts + verify.test.ts
- status: fixed

## deps.clean-env-undeclared-dependency
- first seen: 2026-07-17 · /tmp/debug-e2e-10 · pomodoro-timer
- symptom: "On a clean machine (fresh copy, no node_modules), npm run build failed" across
  rounds; architect had also switched stacks between runs (Vite this time, Next before).
- root cause: LLM-authored manifest with no lockfile; per-run stack nondeterminism. Not
  root-caused deeper — the generation path was replaced by templates the same day.
- fix (structural): golden templates — pinned deps + real lockfile + fixed stack · 3df3a19 ·
  template.test.ts + CI template job
- status: fixed pending live re-verify (e2e-11)

## template.stale-pinned-deps
- first seen: 2026-07-17 · /tmp/debug-e2e-11 (the FIRST template-scaffolded build) · pomodoro-timer
- symptom: depvuln(10 blocking) on round 1 — every finding against the template's own pinned
  next@15.1.6 (middleware auth bypass, RSC pre-auth RCE, several DoS). The deterministic
  dep-bumper converged (round 2: one left), but every build was going to burn ~2 fix rounds
  re-fixing the same known-stale pins.
- root cause: the template pinned the version the author knew, not the currently CVE-clean one.
  Pinned deps trade drift for staleness — the trade is only sound if freshness is enforced.
- fix: templates re-pinned to next@15.5.20 (the maintained 15.x backport line), lockfiles
  regenerated, build+boot re-proven. Next 15.5 also changed standalone output layout under an
  inferred workspace root — pinned outputFileTracingRoot so the layout is invariant. CI's
  template job would have caught a build/boot break but NOT a CVE: freshness needs its own
  check (open idea: run the depvuln scanner against templates/ in CI).
- status: fixed (this entry's open idea tracks the missing enforcement)

## platform.node-env-starved-devdeps
- first seen: 2026-07-17 · /tmp/debug-e2e-11 rounds 2-3 · pomodoro-timer (retroactively: e2e-10's
  identical loop; e2e-9 round 2's "Cannot find namespace 'JSX'")
- symptom: clean-env verify failed "Module not found: Can't resolve '@/components/…'" on a
  workspace whose files were all present; recurred identically across fix rounds because the
  finding blamed the app ("undeclared dependency or lockfile drift") and the fixer looped on the
  wrong layer.
- root cause (reproduced in isolation on the prod box): npm's `omit` config defaults to "dev"
  whenever NODE_ENV=production is in its environment; the platform's own process runs with
  NODE_ENV=production and safeToolEnv forwarded it — every gate-spawned npm install/ci silently
  skipped typescript/tailwindcss/@types, so Next never read tsconfig paths. `npm config get
  omit` → "dev" on the box was the confirming evidence.
- fix: gate-check owns its toolchain env — NODE_ENV removed from TOOL_ENV_ALLOW +
  npm_config_include=dev pinned · 53b7eb2 · verify.test.ts
- status: fixed

## proptest.cross-file-global-pollution
- first seen: 2026-07-18 · /tmp/debug-e2e-12 (held esc-oijrb9) · pomodoro-timer
- symptom: proptest blocked on F2+F4 across 11 fix attempts; the fixer kept "fixing" app behavior
  that was never broken (verified: the failing counterexample ["",0] passes against the real
  lib/storage.ts in isolation).
- root cause (reproduced by pairwise runs on the box): generated property files install global
  fakes (window/localStorage); `bun test <dir>` runs all files in ONE process, so f3's leaked
  globals failed any storage property that ran after it — every file green alone, f3+anything red.
  Generation-time validation runs per-file; the gate ran per-dir — a contract mismatch inside the
  platform.
- fix: the proptest gate runs one process per test file (same assertions, same blocking; each
  finding now carries its own output tail too) · <this commit> · proptest.test.ts
- status: fixed

## infra.model-slug-delisted
- first seen: 2026-07-17 · /tmp/debug-e2e-10 (first attempt) · pomodoro-timer
- symptom: "Model deepseek-v3.2 is not supported" at the first LLM call (OpenCode Zen);
  OpenRouter separately out of credits.
- root cause: provider catalog changed under a pinned slug; no preflight check of the model set.
- fix: reason-lite → deepseek-v4-flash on opencode · ee2c7f6 · models.test.ts. (Open idea: a
  cheap preflight that lists the provider catalog and fails fast with a clear message.)
- status: fixed
