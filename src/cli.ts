#!/usr/bin/env bun
/**
 * drydock CLI. M1: `drydock gate <dir>` runs the deterministic security gate
 * chain on a project directory (PROJECT_BRIEF.md §8, §12).
 */
import { resolve } from "node:path";
import { deployGate, runGate } from "./gate/index.ts";
import { buildEscalationPacket } from "./escalation/index.ts";
import { BoltEngine } from "./engine/bolt/engine.ts";
import { liveBoltDriver } from "./engine/bolt/driver.ts";

export const VERSION = "0.0.0";

export async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;

  if (cmd === "--version") {
    console.log(VERSION);
    return 0;
  }

  if (cmd === "gate" || cmd === "deploy") {
    if (!arg) {
      console.error(`usage: drydock ${cmd} <dir>`);
      return 2;
    }
    const result = cmd === "deploy" ? await deployGate(arg) : await runGate(arg);
    for (const v of result.verdicts) {
      console.log(`\n── gate: ${v.gate} → ${v.status.toUpperCase()} (${v.blocking} blocking) ──`);
      for (const f of v.findings) {
        console.log(`  [${f.severity}] ${f.tool}:${f.ruleId} @ ${f.file}:${f.line ?? "?"}`);
      }
    }
    if (result.passed) {
      console.log("\n✅ PASS — deploy allowed");
      if ("sentinel" in result) console.log(`   sentinel written: ${result.sentinel}`);
    } else {
      console.log("\n🛑 BLOCK — deploy refused");
      if ("sentinel" in result) console.log("   no sentinel written");
    }
    return result.passed ? 0 : 1;
  }

  if (cmd === "generate") {
    const [, promptText, dir] = argv;
    if (!promptText || !dir) {
      console.error('usage: drydock generate "<prompt>" <dir>');
      return 2;
    }
    // Generate live, then auto-gate the freshly generated code (PROJECT_BRIEF.md §8 "Option A").
    const target = resolve(dir);
    const engine = new BoltEngine(liveBoltDriver());
    const session = await engine.startSession(target, { provider: "anthropic", model: "claude-opus-4-8" });
    let failed = false;
    try {
      for await (const ev of session.prompt(promptText)) {
        if (ev.type === "thinking") console.log(`… ${ev.text}`);
        else if (ev.type === "message") console.log(ev.text);
        else if (ev.type === "file-changed") console.log(`  ${ev.action}: ${ev.path}`);
        else if (ev.type === "error") {
          console.error(`generation error: ${ev.message}`);
          failed = true;
        }
      }
    } finally {
      await session.dispose();
    }
    if (failed) return 1; // don't gate a half-generated app

    console.log(`\n── gating generated app at ${target} ──`);
    const result = await runGate(target);
    for (const v of result.verdicts) {
      console.log(`  gate: ${v.gate} → ${v.status.toUpperCase()} (${v.blocking} blocking)`);
    }
    console.log(result.passed ? "\n✅ PASS — deploy allowed" : "\n🛑 BLOCK — fix or escalate (drydock escalate <dir>)");
    return result.passed ? 0 : 1;
  }

  if (cmd === "escalate") {
    if (!arg) {
      console.error("usage: drydock escalate <dir>");
      return 2;
    }
    const result = await runGate(arg);
    if (result.passed) {
      console.log("✅ no blocking findings — nothing to escalate");
      return 0;
    }
    const packet = await buildEscalationPacket(result.verdicts, arg);
    console.log(`\n📦 escalation packet — ${packet.blocking} slice(s), routes: ${packet.specialties.join(", ")}`);
    for (const item of packet.items) {
      console.log(`\n── [${item.specialty}] ${item.finding.tool}:${item.finding.ruleId} ──`);
      console.log(`   ${item.finding.message}`);
      if (item.slice) {
        console.log(`   ${item.slice.file}:${item.slice.startLine}-${item.slice.endLine}`);
        for (const line of item.slice.code.split("\n")) console.log(`   │ ${line}`);
      } else {
        console.log(`   (no slice — ${item.finding.file})`);
      }
    }
    return 1;
  }

  console.log(
    [
      "drydock — safe vibe coding.",
      "",
      '  drydock generate "<prompt>" <dir>   generate an app (bolt engine) + auto-gate it',
      "  drydock gate <dir>                  run the security gate chain (report only)",
      "  drydock deploy <dir>                run the chain + write the deploy sentinel iff all pass",
      "  drydock escalate <dir>             localize blocking findings into a routed review packet",
      "",
      "Gates: verify · sast · secrets · rls (PROJECT_BRIEF.md §8, §12).",
      "generate needs ANTHROPIC_API_KEY.",
    ].join("\n"),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
