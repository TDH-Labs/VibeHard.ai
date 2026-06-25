# Broken-app fixtures — the build/autofix regression harness

Each directory reproduces ONE failure class that has actually held a real build, so the
gate + auto-fixer's handling of it is locked by a fast test (`src/autofix/build-loop.harness.test.ts`)
instead of being rediscovered the slow way (a 30-minute live build).

| Fixture | Class | What must happen |
|---|---|---|
| `undeclared-dep/` | imports a real package not in package.json (`stripe`) | `detectUndeclaredImports` + `parseMissingModules` flag it → deterministic `npm install` |
| `missing-export/` | imports a symbol the module doesn't export (`supabaseAdmin`) | `parseBuildErrors` localizes it to the module file → fixer context includes module **and** importers |

Captured real build logs for log-parsing assertions live in `fixtures/build-logs/`:
`undeclared-dep.log`, `missing-export.log`, `async-headers.log` (Next 15 async `headers()`).

These are intentionally minimal — just enough source to exercise the deterministic
disposition. The gated end-to-end test (`VIBEHARD_INTEGRATION=1`) runs the real
gate+fixer against them.
