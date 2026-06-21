#!/usr/bin/env bun
/**
 * drydock CLI. M1: `drydock gate <dir>` runs the deterministic security gate
 * chain on a project directory (PROJECT_BRIEF.md §8, §12).
 */
import { runGate } from "./gate/index.ts";

export const VERSION = "0.0.0";

export async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;

  if (cmd === "--version") {
    console.log(VERSION);
    return 0;
  }

  if (cmd === "gate") {
    if (!arg) {
      console.error("usage: drydock gate <dir>");
      return 2;
    }
    const { verdicts, passed } = await runGate(arg);
    for (const v of verdicts) {
      console.log(`\n── gate: ${v.gate} → ${v.status.toUpperCase()} (${v.blocking} blocking) ──`);
      for (const f of v.findings) {
        console.log(`  [${f.severity}] ${f.tool}:${f.ruleId} @ ${f.file}:${f.line ?? "?"}`);
      }
    }
    console.log(passed ? "\n✅ PASS — deploy allowed" : "\n🛑 BLOCK — deploy refused");
    return passed ? 0 : 1;
  }

  console.log(
    [
      "drydock — safe vibe coding.",
      "",
      "  drydock gate <dir>   run the security gate chain on a project",
      "",
      "M1 in progress (PROJECT_BRIEF.md §8, §12). Gates: sast + secrets (live); rls/verify next.",
    ].join("\n"),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
