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
import { buildGenerationBrief, decideRigor, llmIntake, planIntake, type Spec } from "./spec/index.ts";
import { isBlocking, type Finding, type Severity } from "./types.ts";

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

/** Print a spec the way an operator reads it (§22 front-half). */
function printSpec(spec: Spec): void {
  console.log(`\n📄 Spec: ${spec.name}`);
  if (spec.summary) console.log(`   ${spec.summary}`);
  console.log(`   users: ${spec.users || "—"} · tenancy: ${spec.tenancy} · auth: ${spec.auth}`);
  if (spec.features.length) {
    console.log("   features:");
    for (const f of spec.features) console.log(`     - ${f}`);
  }
  if (spec.dataEntities.length) {
    console.log("   data model:");
    for (const e of spec.dataEntities) console.log(`     - ${e.name}(${e.fields.join(", ")})${e.sensitive ? "  [sensitive]" : ""}`);
  }
  const sens = spec.sensitiveData.filter((c) => c !== "none");
  if (sens.length) console.log(`   sensitive data: ${sens.join(", ")}`);
}

/** Run the engine over `target` with `prompt`; stream events. Returns false on a
 *  generation error (so the caller skips gating a half-built app). Shared by
 *  `generate` (raw prompt) and `build` (PRD brief). */
async function streamGeneration(target: string, prompt: string, provider: string, model: string): Promise<boolean> {
  const session = await new BoltEngine(liveBoltDriver()).startSession(target, { provider, model });
  let ok = true;
  try {
    for await (const ev of session.prompt(prompt)) {
      if (ev.type === "thinking") console.log(`… ${ev.text}`);
      else if (ev.type === "message") console.log(ev.text);
      else if (ev.type === "file-changed") console.log(`  ${ev.action}: ${ev.path}`);
      else if (ev.type === "error") {
        console.error(`generation error: ${ev.message}`);
        ok = false;
      }
    }
  } finally {
    await session.dispose();
  }
  return ok;
}

/** Gate `target` and print the verdict the operator-facing way. Returns passed. */
async function gateAndReport(target: string): Promise<boolean> {
  const result = await runGate(target);
  for (const v of result.verdicts) console.log(`  ${v.gate} → ${v.status.toUpperCase()} (${v.blocking} blocking)`);
  if (!result.passed) {
    console.log("\nWhat needs attention before this can ship:");
    for (const v of result.verdicts) for (const f of v.findings) explainFinding(f);
    console.log("\n🛑 BLOCK — fix or escalate (drydock escalate <dir>)");
  } else {
    const warnings = result.verdicts.flatMap((v) => v.findings);
    if (warnings.length) {
      console.log("\n⚠️  Heads-up (not blocking — worth a reviewer's eye):");
      for (const v of result.verdicts) for (const f of v.findings) explainFinding(f);
    }
    console.log("\n✅ PASS — deploy allowed");
  }
  return result.passed;
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

  if (cmd === "plan") {
    const [, promptText] = argv;
    if (!promptText) {
      console.error('usage: drydock plan "<prompt>"');
      return 2;
    }
    // Front-half (§22): the LLM drafts a PRD, the deterministic readiness check grills
    // it, and it re-drafts to resolve blocking gaps — bounded. Spec proposed, gate disposes.
    const provider = process.env.DRYDOCK_PROVIDER || (process.env.OPENCODE_API_KEY ? "opencode" : "anthropic");
    const model = process.env.DRYDOCK_MODEL || (provider === "opencode" ? "deepseek-v4-pro" : "claude-opus-4-8");
    console.log(`drafting a spec with ${provider}/${model} …`);
    const result = await planIntake(promptText, {
      intake: llmIntake({ config: { provider, model } }),
      onStep: (m) => console.log(`  … ${m}`),
    });
    printSpec(result.spec);
    console.log(`\n   rigor: ${decideRigor(result.spec)} (§16 adaptive)`);

    const advisory = result.gaps.filter((f) => !isBlocking(f));
    if (advisory.length) {
      console.log("\n⚠️  Heads-up to carry into the build (not blocking):");
      for (const f of advisory) explainFinding(f);
    }
    if (result.ready) {
      console.log(`\n✅ spec ready to build (after ${result.rounds} round(s)) — next: drydock generate "<this app>" <dir>`);
      return 0;
    }
    console.log(`\n🛑 spec NOT ready after ${result.rounds} round(s) — these need clarifying first:`);
    for (const f of result.gaps.filter(isBlocking)) explainFinding(f);
    return 1;
  }

  if (cmd === "build") {
    const [, promptText, dir] = argv;
    if (!promptText || !dir) {
      console.error('usage: drydock build "<prompt>" <dir>');
      return 2;
    }
    const target = resolve(dir);
    const provider = process.env.DRYDOCK_PROVIDER || (process.env.OPENCODE_API_KEY ? "opencode" : "anthropic");
    const model = process.env.DRYDOCK_MODEL || (provider === "opencode" ? "deepseek-v4-pro" : "claude-opus-4-8");

    // 1. Front-half (§22): plan + grill. A spec with BLOCKING gaps must not proceed
    //    to codegen — the front-half gate refuses to build an underspecified app.
    console.log(`planning with ${provider}/${model} …`);
    const plan = await planIntake(promptText, {
      intake: llmIntake({ config: { provider, model } }),
      onStep: (m) => console.log(`  … ${m}`),
    });
    printSpec(plan.spec);
    console.log(`\n   rigor: ${decideRigor(plan.spec)} (§16 adaptive)`);
    for (const f of plan.gaps.filter((g) => !isBlocking(g))) {
      console.log("\n⚠️  built into the spec (not blocking):");
      explainFinding(f);
    }
    if (!plan.ready) {
      console.log("\n🛑 spec NOT ready — clarify these and retry (not building an underspecified app):");
      for (const f of plan.gaps.filter(isBlocking)) explainFinding(f);
      return 1;
    }

    // 2. Generate AGAINST the spec — its security posture becomes explicit build
    //    instructions (the front-half's payoff).
    console.log(`\n── generating against the spec → ${target} ──`);
    if (!(await streamGeneration(target, buildGenerationBrief(plan.spec), provider, model))) return 1;

    // 3. Back-half: gate the result.
    console.log(`\n── gating generated app at ${target} ──`);
    return (await gateAndReport(target)) ? 0 : 1;
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
    if (!(await streamGeneration(target, promptText, provider, model))) return 1; // don't gate a half-built app
    console.log(`\n── gating generated app at ${target} ──`);
    return (await gateAndReport(target)) ? 0 : 1;
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
      '  drydock plan "<prompt>"             draft + grill a PRD spec before building (front-half §22)',
      '  drydock build "<prompt>" <dir>      plan → generate against the spec → gate (full pipeline)',
      '  drydock generate "<prompt>" <dir>   generate an app from a raw prompt (engine only) + auto-gate it',
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
