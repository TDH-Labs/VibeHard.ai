/**
 * Generate the GitHub Actions workflow that runs VibeHard's gates as a REQUIRED check (roadmap Phase
 * 4, live half). Dropped into each app at .github/workflows/gate.yml so the same gate chain that runs
 * locally also gates every PR merge — "gates as a required GitHub check." Deterministic + owned (the
 * @vibehard:generated marker, like the backend), so a team can edit it and we stop overwriting.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MARKER = "@vibehard:generated";

export interface CiOptions {
  /** the command that runs the gate chain in CI. Default assumes the vibehard CLI is resolvable. */
  gateCommand?: string;
  /** branch the PR targets (the merge point). Default "main". */
  baseBranch?: string;
}

export function ciWorkflowYaml(opts: CiOptions = {}): string {
  const gate = opts.gateCommand ?? "bunx --bun vibehard gate .";
  const base = opts.baseBranch ?? "main";
  return `# ${MARKER} — gates as a required check. Edit freely; the marker hands ownership back to you.
name: vibehard-gate
on:
  pull_request:
    branches: [${base}]
  push:
    branches: [${base}]
permissions:
  contents: read
jobs:
  gate:
    name: vibehard gate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: install dependencies
        run: bun install --frozen-lockfile
      - name: run the gate chain (sast · secrets · depvuln · rls · migrate · compliance · pii · prod-readiness · verify)
        run: ${gate}
`;
}

export interface CiResult {
  path: string;
  written: boolean;
  /** false → a user-owned (marker-stripped) file was preserved, not overwritten. */
  skippedUserOwned: boolean;
}

/** Write .github/workflows/gate.yml. Generate-then-own: if the file exists WITHOUT our marker, the
 *  user took ownership — leave it. */
export function generateCiWorkflow(target: string, opts: CiOptions = {}): CiResult {
  const path = join(target, ".github", "workflows", "gate.yml");
  if (existsSync(path) && !readFileSync(path, "utf8").includes(MARKER)) {
    return { path, written: false, skippedUserOwned: true };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ciWorkflowYaml(opts));
  return { path, written: true, skippedUserOwned: false };
}
