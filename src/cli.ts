#!/usr/bin/env bun
/**
 * drydock CLI — entry point.
 *
 * STUB. The first milestone (PROJECT_BRIEF.md §8) replaces this with:
 *   drydock gate <dir>   run the gate chain on a target directory
 * porting the orchestration from ~/dev/gate-proof/gates/ into a typed
 * `src/gate/` library that returns Finding[] / GateResult.
 */

export const VERSION = "0.0.0";

function main(argv: string[]): number {
  const [cmd] = argv;
  if (cmd === "--version") {
    console.log(VERSION);
    return 0;
  }
  console.log(
    [
      "drydock — safe vibe coding (skeleton).",
      "",
      "Not implemented yet. Start here: PROJECT_BRIEF.md §8 (First task).",
      "M1: drydock gate <dir>  — port ~/dev/gate-proof into src/gate/.",
    ].join("\n"),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
