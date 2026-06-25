# AcmeCare — the hardening log (all variations)

AcmeCare (a child-care management app: enrollment, attendance, meals, health records, billing,
messaging, staff scheduling, RBAC, photo sharing — multi-tenant) was VibeHard's stress-test app.
Building it ~8 times exposed where the pipeline broke and drove every fix below. This is the
decision record: what each variation taught, and the conventions/mechanisms we converged on.

## The variations

| # | Build | Codegen model | Outcome | What it taught |
|---|---|---|---|---|
| 1 | original | deepseek-v4-flash | catastrophic (34 type errors, wrong `@supabase/ssr` usage, Clerk) | flash-on-codegen ≠ viable; root cause = codegen prompt, not just the model |
| 2 | rebuild | kimi-k2.7-code | held: undeclared deps, lockfile drift, `supabaseAdmin` export split | → deterministic dep install, `installStale`, build-error **localization**, wider fixer context |
| 3 | C (+Next15) | kimi | held: RLS service-key, Stripe `apiVersion`, a dep | Next-15 convention **works** (0 unawaited `headers()`); failures moved to new classes |
| 4 | A/B | GLM-5.2 **vs** kimi | both held 7/8, ~equivalent | **model is a commodity for quality**; GLM closed RLS, kimi held on an internal `sendEmail` arity bug |
| 5 | weak-model | flash, qwen3.6-plus | both held 7/8, same band as the strong models | **scaffolding lifts cheap models** to the strong band; the capability floor is below flash |
| 6 | v2 (all conventions) | GLM-5.2 | held only on deps → missing Supabase files → **hand-finished to a clean build (18 routes)** | conventions all validated (0 unawaited, 0 apiVersion, rls ✓); the residual was a long tail of bounded classes |
| 7 | v3 | GLM-5.2 | **compromised** — inherited Clerk from the seeded architecture; killed | planning decisions (Clerk) override codegen conventions → need a **feedback loop to the design docs** |
| 8 | clean | GLM-5.2 | (in progress) fresh planning, no Clerk, journal + all fixes | the real autonomous test |

## Conventions converged on (pinned in the codegen / architect prompts)

- **Next 15 async APIs** — `await headers()/cookies()`; `params`/`searchParams` are Promises.
- **Supabase clients** — create EXACTLY `lib/supabase/{client,server,admin}.ts`, import by those exact paths, no flat `lib/supabase.ts`.
- **Supabase Auth, NEVER Clerk/Auth0/NextAuth** — a third-party provider breaks the `auth.uid()` link RLS depends on (now a hard AUTH CONSTRAINT in the architect prompt).
- **Stripe / integration SDKs** — OMIT `apiVersion` (use the SDK default); webhooks read raw body + `constructEventAsync`. Don't guess post-cutoff version literals.
- **RLS** — the service-role client only on admin-only server paths; user features go through the request-scoped RLS client.
- **Internal consistency** — a helper's definition and every call site agree on arity/shape; a `page.tsx` exports only its default + Next's allowed members (server actions go in `actions.ts` or stay unexported).

## Harness mechanisms built

- **Deterministic disposers** — `missingdeps` (install ALL undeclared imports at once), `installStale` (reinstall when package.json changed), `depbump`, `scaffoldConfigs` (postcss/tailwind boilerplate), `normalizeLayout`.
- **Localization** (`parseBuildErrors`) — export mismatch, unresolved npm package, **unresolved internal module** (file imported but never generated), Next-format type errors, and **raw `tsc --noEmit` batched errors**.
- **Fixer** — reads the finding-named files + symbol-referencers in full; batched `tsc` (fix the whole tail in one pass, not one-per-rebuild); reads the **as-built journal** to avoid repeating failed fixes.
- **Loop** — convergence-based (plateau at 3 flat rounds, not 2); the **as-built journal** records every round.
- **Tooling** — `vibehard diagnose <dir> [--build]` for fast triage; the conversational **orchestrator**.

## Economics (measured)

Per identical codegen call: flash 6,185 tokens, GLM-5.2 2,250, kimi 4,048 — flash uses ~2.75× the
tokens (reasoning overhead). BUT OpenCode **Go meters in dollar value** of usage, and flash's
per-token rate is ~16× lower, so flash costs **~5.6× LESS** per task (~$0.0017 vs GLM ~$0.0096) →
the cheapest *and* equal-quality choice on the subscription. (VibeHard should log `cost` +
`tokens_reasoning` per build — OpenCode's own DB already has those columns.)

## The meta-lesson

The model is a commodity for *quality* (the scaffolding equalizes it) but not for *token efficiency*.
Every real improvement came from the **system** — conventions (the learning), gates (the verifier),
deterministic fixers (the hands), and now the journal + convention-aware planning (the feedback loop).
Where the pipeline still falls short on a *large* app is the long tail of defects discovered serially;
the batched-`tsc` + deterministic-scaffold + journal work is the answer, and the clean run is its test.

## Open items

- Clean full-pipeline run (variation 8) — does it complete autonomously and choose Supabase?
- Dashboard auth on Supabase (Path B chosen, not yet built).
- LLM functional testing of the built app (beyond "it builds").
- Per-build token/cost logging (the standing economics signal).
