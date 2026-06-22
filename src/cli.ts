#!/usr/bin/env bun
/**
 * drydock CLI. M1: `drydock gate <dir>` runs the deterministic security gate
 * chain on a project directory (PROJECT_BRIEF.md §8, §12).
 */
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { deployGate, runGate } from "./gate/index.ts";
import { buildEscalationPacket, LocalEscalationSink, type TicketState } from "./escalation/index.ts";
import { BoltEngine } from "./engine/bolt/engine.ts";
import { liveBoltDriver } from "./engine/bolt/driver.ts";
import { translateFinding } from "./translate/index.ts";
import { autoFix } from "./autofix/index.ts";
import type { Finding, Severity } from "./types.ts";

export const VERSION = "0.0.0";

const SEV_DOT: Record<Severity, string> = { critical: "🔴", high: "🔴", medium: "🟠", low: "🟡" };

/** The escalation queue location — a per-machine reviewer queue (§24 async queue).
 *  Override with DRYDOCK_QUEUE_DIR. */
function queuePath(): string {
  return process.env.DRYDOCK_QUEUE_DIR ?? join(homedir(), ".drydock", "queue");
}
function localSink(): LocalEscalationSink {
  return new LocalEscalationSink(queuePath());
}

/** Print a finding the way a non-technical operator reads it: plain-English first
 *  (the §15 translation), with the technical ruleId kept as a dim sub-line. */
function explainFinding(f: Finding, indent = "  "): void {
  const e = translateFinding(f);
  console.log(`${indent}${SEV_DOT[f.severity]} ${e.title}`);
  console.log(`${indent}   ${e.detail}`);
  console.log(`${indent}   ${f.message}`); // the scanner's specific instance (e.g. which package/version)
  console.log(`${indent}   ↳ ${f.tool}:${f.ruleId} @ ${f.file}:${f.line ?? "?"}`);
}

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
      console.log(`\n── ${v.gate} → ${v.status.toUpperCase()} (${v.blocking} blocking) ──`);
      for (const f of v.findings) explainFinding(f);
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
    // Provider/model selection: explicit override wins; else opencode when its key is
    // present, otherwise anthropic. Logged so the choice is never silent.
    const provider = process.env.DRYDOCK_PROVIDER || (process.env.OPENCODE_API_KEY ? "opencode" : "anthropic");
    const model = process.env.DRYDOCK_MODEL || (provider === "opencode" ? "deepseek-v4-pro" : "claude-opus-4-8");
    console.log(`generating with ${provider}/${model} → ${target}`);
    const engine = new BoltEngine(liveBoltDriver());
    const session = await engine.startSession(target, { provider, model });
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
      console.log(`  ${v.gate} → ${v.status.toUpperCase()} (${v.blocking} blocking)`);
    }
    if (!result.passed) {
      console.log("\nWhat needs attention before this can ship:");
      for (const v of result.verdicts) for (const f of v.findings) explainFinding(f);
      console.log("\n🛑 BLOCK — fix or escalate (drydock escalate <dir>)");
    } else {
      // On PASS every finding is non-blocking (medium/low) — surface them as
      // heads-up warnings (e.g. an RLS rule that's broader than per-user) so they
      // don't vanish on the happy path; a reviewer should still eyeball them.
      const warnings = result.verdicts.flatMap((v) => v.findings);
      if (warnings.length) {
        console.log("\n⚠️  Heads-up (not blocking — worth a reviewer's eye):");
        for (const v of result.verdicts) for (const f of v.findings) explainFinding(f);
      }
      console.log("\n✅ PASS — deploy allowed");
    }
    return result.passed ? 0 : 1;
  }

  if (cmd === "fix") {
    if (!arg) {
      console.error("usage: drydock fix <dir>");
      return 2;
    }
    const target = resolve(arg);
    console.log(`auto-fixing ${target} (gate → fix → re-gate, bounded) …`);
    const result = await autoFix(target, { onStep: (m) => console.log(`  … ${m}`) });
    if (result.fixed) {
      console.log(`\n✅ auto-fix succeeded — gate green after ${result.attempts} attempt(s).`);
      return 0;
    }
    // Auto-fix exhausted → HOLD for human review (a distinct `needs-human` state,
    // not a failed build — §24) and QUEUE it async. The pipeline stops here; the
    // human works it off-path and the re-gate (resume) returns it to the line.
    console.log(`\n🛑 auto-fix could not resolve everything in ${result.attempts} attempt(s).`);
    if (result.escalation) {
      const ticket = await localSink().open(result.escalation);
      console.log(`   → held for human review (needs-human): ticket ${ticket.id}`);
      console.log(`   queued at ${queuePath()} — list with: drydock queue`);
    }
    console.log("\n   residual blocking findings:");
    for (const v of result.finalVerdicts) for (const f of v.findings) explainFinding(f);
    return 1;
  }

  if (cmd === "queue") {
    const state = arg as TicketState | undefined; // optional filter: needs-human | claimed | resolved
    const tickets = await localSink().list(state);
    if (!tickets.length) {
      console.log(`queue empty${state ? ` (state: ${state})` : ""} — ${queuePath()}`);
      return 0;
    }
    console.log(`${tickets.length} ticket(s)${state ? ` in ${state}` : ""} — ${queuePath()}`);
    for (const t of tickets) {
      console.log(`\n  ${t.id}  [${t.state}]${t.claimedBy ? ` · claimed by ${t.claimedBy}` : ""}`);
      console.log(`     ${t.packet.blocking} blocking · routes: ${t.packet.specialties.join(", ")}`);
      console.log(`     app: ${t.packet.workspacePath} · created ${t.createdAt}`);
    }
    return 0;
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
    const ticket = await localSink().open(packet); // hold + queue for async human review (§24)
    console.log(`\n📦 escalation packet — ${packet.blocking} slice(s), routes: ${packet.specialties.join(", ")}`);
    console.log(`   held for review: ticket ${ticket.id} [${ticket.state}] — queued at ${queuePath()}`);
    for (const item of packet.items) {
      const e = translateFinding(item.finding);
      // Operator-facing plain English…
      console.log(`\n── [${item.specialty}] ${SEV_DOT[item.finding.severity]} ${e.title} ──`);
      console.log(`   ${e.detail}`);
      // …then the engineer-facing technical detail + localized slice.
      console.log(`   ↳ ${item.finding.tool}:${item.finding.ruleId} — ${item.finding.message}`);
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
      "  drydock fix <dir>                  auto-fix blocked findings (LLM + dep-bump), re-gate, else hold for review",
      "  drydock escalate <dir>             localize blocking findings into a routed review packet + queue it",
      "  drydock queue [state]              list held escalations (needs-human | claimed | resolved)",
      "",
      "Gates: verify · sast · secrets · depvuln · rls (PROJECT_BRIEF.md §8, §12).",
      "generate needs ANTHROPIC_API_KEY. Review queue dir: DRYDOCK_QUEUE_DIR (default ~/.drydock/queue).",
    ].join("\n"),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
