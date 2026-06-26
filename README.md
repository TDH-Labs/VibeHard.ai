# VibeHard

> **Safe vibe coding.** An enforced engineering gate chain that sits between an
> AI app generator and `deploy` — so a non-technical person gets a *secure*,
> production-grade app, not just a working one. When a gate hits a call it can't
> safely auto-resolve, an on-demand engineer reviews the one flagged slice.

**Working name** (placeholder): *VibeHard* — where a vessel is inspected and made
seaworthy before it sails. Builds on **Harbor** (the skill/room substrate).

## Status
What is **verified by executing tests** (not asserted): the gate chain blocks
vulnerable AI-generated apps and passes fixed ones; the deterministic backend
generator's tenant isolation is *proven* by an enforcement gate that runs real
cross-tenant queries against embedded Postgres and asserts denial (`src/gate/
rls-enforce.ts`); the security remediation in [`REMEDIATION.md`](./REMEDIATION.md)
(P0+P1) is complete, each fix backed by a test that would fail if the bug were
still live.

What is **not yet done**: no generated app has been deployed to real
infrastructure and attacked in production. That live deploy + cross-tenant
attack is the pipeline's acceptance test (REMEDIATION.md → E1) and is pending
credentials. Until it's green, treat "production-ready" as the design goal the
gates enforce, not a demonstrated outcome on a live app.

👉 **Read [`PROJECT_BRIEF.md`](./PROJECT_BRIEF.md) first** — it's the self-contained
brief (problem, architecture, stack, assets, and the first task). Everything you
need to start cold is there.

## Stack
TypeScript on **Bun**. Security scanners (semgrep, gitleaks, …) run as pinned
**containers** and are *invoked*, never rewritten. No Python in the core.

## Develop
```bash
bun install
bun test            # test suite (must stay green)
bun run typecheck   # tsc --noEmit (must stay green)
bun run src/cli.ts  # the vibehard CLI (stub today)
```

## First milestone (M1)
Port `~/dev/gate-proof/`'s gate orchestration from bash into `src/gate/` as a
typed library returning `Finding[]` / `GateResult`, reusing the existing scanners
and rules verbatim. **Done when** `vibehard gate ~/dev/gate-proof/app` reproduces
the proof's verdict (BLOCK vulnerable, PASS remediated) from TypeScript. See
`PROJECT_BRIEF.md` §8–9.

## Requirements
- [Bun](https://bun.sh) ≥ 1.1
- Docker / OrbStack (for the containerized scanners)
