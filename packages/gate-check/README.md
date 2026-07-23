# @vibehard/gate-check

The deterministic gate chain VibeHard runs before it ships a generated app. Usable standalone,
with zero VibeHard dependency, against any codebase:

```
bunx gate-check [gate|deploy] <dir>   # defaults to "gate"
```

or from inside VibeHard's own CLI: `vibehard gate <dir>` / `vibehard deploy <dir>`.

## What it actually checks

Twelve gates, each a deterministic, pattern/inventory-based check:

- **sast** (semgrep) — known-bad code patterns
- **secrets** (gitleaks) — leaked credentials
- **depvuln** (trivy) — known CVEs in dependencies
- **rls** / **rls-enforce** / **migrate** — Supabase Row-Level Security shape checks + real
  migration execution against an embedded Postgres
- **compliance** / **pii** — data-classification posture checks
- **prod-readiness** — missing hardening (unpinned base images, no `USER` directive, mutable
  CI tags, etc.)
- **proptest** — generated property tests still pass
- **verify** — the app actually builds and boots
- **completeness** — an LLM checks generated code against a persisted spec (`n/a` when no spec
  exists, which is the normal case for a non-VibeHard project; blocks with a "not configured"
  finding if a spec WITH features exists but no reviewer is wired in — this package ships none)

## What it does NOT check

**These are pattern/inventory scanners, not a security review of your application's logic.**
None of them reason about what your code actually *does* — they can't tell an authorization
bypass from a fix, evaluate a trust model, or catch a logic bug that doesn't match a known
signature.

This was verified empirically, not assumed: running the full chain against both the
pre-fix and post-fix commits of a real unauthenticated critical (an unauthenticated endpoint
allowing state-changing requests) produced **identical verdicts** — zero findings touched the
authorization model either time. The dependency-CVE count even went *up* after the fix, because
the remediation pulled in a new transitive dependency.

Severity is also **context-free**: a CVE gets flagged the same whether the vulnerable code path
is reachable or not (e.g. an image-optimization CVE in a project that ships as a static export
with no server runtime). Triaging reachability is on you.

**If you need**: authorization/trust-model review, business-logic correctness, or anything
requiring reasoning about *this specific codebase's* semantics — that's a human review or an
LLM red-team pass, not this tool. `vibehard gate`'s own output prints this same caveat after
every run.

## Why it's still worth running

Real, load-bearing signal for the class of problem it targets: known CVEs, leaked secrets,
missing hardening (mutable CI action tags, no `USER` in a Dockerfile), and — for Supabase
apps — RLS/migration shape checks executed against a real embedded Postgres, not just read as
text. Fail-closed by design: a scanner that couldn't run is a blocking finding, never a silent
pass.
