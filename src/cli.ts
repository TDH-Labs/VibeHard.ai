#!/usr/bin/env bun
/**
 * vibehard CLI. M1: `vibehard gate <dir>` runs the deterministic security gate
 * chain on a project directory (PROJECT_BRIEF.md §8, §12).
 */
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deployGate, runGate } from "./gate/index.ts";
import { buildEscalationPacket, GitHubEscalationSink, LocalEscalationSink, type ReviewDecision, type ReviewVerdict, type TicketState } from "./escalation/index.ts";
import { nullNotifier, slackNotifier, type Notifier } from "./escalation/notify.ts";
import { SPECIALTIES } from "./escalation/routing.ts";
import { FileReviewerStore, makeReviewer, matchesPacket, parseSpecialties } from "./reviewer/reviewer.ts";
import { BoltEngine } from "./engine/bolt/engine.ts";
import { liveBoltDriver } from "./engine/bolt/driver.ts";
import { PYTHON_SYSTEM_PROMPT, selectSystemPrompt } from "./engine/bolt/prompt.ts";
import { designBlock } from "./design/presets.ts";
import { scaffoldDesignSystem } from "./design/scaffold.ts";
import { artDirectorRefactorer, artDirectorScorer } from "./design/art-director.ts";
import { llmFunctionalReviewer, summarize } from "./functest/functest.ts";
import { configForStage, modelForStage, modelPlan, providerOf } from "./config/models.ts";
import { diagnose, formatDiagnosis } from "./diagnose/diagnose.ts";
import { seedJournal } from "./journal/journal.ts";
import { fleetBlock } from "./fleet/fleet.ts";
import { approveConvention, pendingConventions, runInduction } from "./fleet/induct.ts";
import { translateFinding } from "./translate/index.ts";
import { autoFix } from "./autofix/index.ts";
import { decideRigor, foldInterview, llmIntake, llmInterviewer, MAX_QUESTIONS, planIntake, type InterviewTurn, type Spec } from "./spec/index.ts";
import { elaboratePrd, llmElaborator, renderPrdMarkdown, type Prd } from "./prd/index.ts";
import { elaborateSrs, llmSpecifier, renderSrsMarkdown, type Srs } from "./srs/index.ts";
import { architectApp, buildOrder, llmArchitect, renderSadMarkdown, type Architecture } from "./architecture/index.ts";
import { reviewFrontHalf, llmAdversary } from "./spec-review/index.ts";
import { workstreamBrief } from "./build/workstream-brief.ts";
import { runProdScan } from "./prod-feedback/index.ts";
import { deployApp } from "./substrate/index.ts";
import { LocalBuildRunner, Platform, planFor } from "./platform/index.ts";
import {
  capabilitiesFromSpec,
  combinedCandidateSource,
  depsDevEvidenceProvider,
  llmSummarizer,
  npmSearchCandidateSource,
  registryCandidateSource,
  researchProcurement,
  type Advisory,
} from "./procurement/index.ts";
import { fileCheckpointer, llmRefactorer, llmScorer, refactorPhase } from "./refactor/index.ts";
import { refine } from "./refine/refine.ts";
import { runTiers } from "./util/pool.ts";
import { requiredCredentialsForApp } from "./credentials/index.ts";
import { isBlocking, type Finding, type Severity } from "./types.ts";

export const VERSION = "0.0.0";

const SEV_DOT: Record<Severity, string> = { critical: "🔴", high: "🔴", medium: "🟠", low: "🟡" };

/** The escalation queue location — a per-machine reviewer queue (§24 async queue).
 *  Override with VIBEHARD_QUEUE_DIR. */
function queuePath(): string {
  return process.env.VIBEHARD_QUEUE_DIR ?? join(homedir(), ".vibehard", "queue");
}
function localSink(): LocalEscalationSink {
  return new LocalEscalationSink(queuePath());
}
function reviewerStore(): FileReviewerStore {
  return new FileReviewerStore(process.env.VIBEHARD_REVIEWERS_DIR ?? join(homedir(), ".vibehard", "reviewers"));
}
/** Slack ping when a packet is queued, iff a webhook is configured; else a silent no-op.
 *  Best-effort by contract (notifyOpened never throws) — a Slack outage never loses a ticket. */
function notifier(): Notifier {
  const url = process.env.VIBEHARD_SLACK_WEBHOOK;
  return url ? slackNotifier(url) : nullNotifier;
}

/** Persist the spec into the project (.vibehard/spec.json) so the compliance gate
 *  (§21) has the data classification at gate time — the front-half's durable output. */
function persistSpec(target: string, spec: Spec): void {
  const dir = join(target, ".vibehard");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.json"), JSON.stringify(spec, null, 2));
}

/** Persist the PRD: PRD.md (the readable Principal-PM document the operator + reviewer read)
 *  + .vibehard/prd.json (structured, for tooling). The front-half's richest durable output. */
function persistPrd(target: string, prd: Prd): void {
  const dir = join(target, ".vibehard");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prd.json"), JSON.stringify(prd, null, 2));
  writeFileSync(join(target, "PRD.md"), renderPrdMarkdown(prd));
}

/** Persist the SRS: SRS.md (the readable Principal-Systems-Architect document for engineers + QA)
 *  + .vibehard/srs.json. Stage 3's durable output, between the PRD and the architecture. */
function persistSrs(target: string, srs: Srs): void {
  const dir = join(target, ".vibehard");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "srs.json"), JSON.stringify(srs, null, 2));
  writeFileSync(join(target, "SRS.md"), renderSrsMarkdown(srs));
}

/** Persist the SAD: SAD.md (the Software Architecture Document for engineers + reviewers) +
 *  .vibehard/architecture.json (the design without the nested prd/srs — those persist separately). */
function persistSad(target: string, arch: Architecture): void {
  const dir = join(target, ".vibehard");
  mkdirSync(dir, { recursive: true });
  const { prd: _p, srs: _s, ...design } = arch;
  writeFileSync(join(dir, "architecture.json"), JSON.stringify(design, null, 2));
  writeFileSync(join(target, "SAD.md"), renderSadMarkdown(arch));
}

/** Resume support: load a stage's saved artifact (.vibehard/<file>) so a re-run skips work it
 *  already finished. A stopped/paused build continues where it left off — no re-spend. */
function loadStage<T>(target: string, file: string): T | null {
  const p = join(target, ".vibehard", file);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

const DISPOSITION_LABEL: Record<Advisory["disposition"], string> = {
  "adopt-oss": "✅ ADOPT open-source",
  "buy-service": "💳 BUY a service",
  build: "🔨 BUILD it",
  "needs-human": "🤔 YOUR CALL",
};

/** Print one procurement advisory the way a non-technical operator reads it (§22). */
function printAdvisory(a: Advisory): void {
  console.log(`\n━━ ${a.capability.key} → ${DISPOSITION_LABEL[a.disposition]} ━━`);
  console.log(`   ${a.rationale}`);
  const top = a.options.slice(0, 4);
  if (top.length) console.log("   options (vetted):");
  for (const o of top) {
    const meta =
      o.candidate.kind === "service"
        ? "service"
        : [
            o.evidence?.license ?? "license?",
            o.evidence?.scorecard != null ? `scorecard ${o.evidence.scorecard.toFixed(1)}` : null,
            o.evidence?.ageDays != null ? `${Math.round(o.evidence.ageDays / 30)}mo old` : null,
          ]
            .filter(Boolean)
            .join(", ");
    console.log(`   ${o.safety.safe ? "✓" : "✗"} ${o.candidate.name}  (${meta})  health ${o.score}/100`);
    const note = o.safety.safe ? o.safety.warnings[0] : o.safety.blockers[0];
    if (note) console.log(`       ${o.safety.safe ? "⚠" : "✗"} ${note}`);
  }
  if (top.some((o) => o.candidate.kind === "package")) {
    // The number rates HEALTH (license/security/maintenance/adoption), NOT fitness for
    // this app — OSS options are keyword-discovered, so a healthy-but-wrong package can
    // out-score a proven service. Fitness is the recommendation above, or a person's call.
    console.log('   ↳ open-source options are keyword-discovered + vetted for safety only; "health" ≠ fitness for your app');
  }
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
async function streamGeneration(target: string, prompt: string, provider: string, model: string, systemPrompt?: string, label?: string): Promise<boolean> {
  const tag = label ? `[${label}] ` : ""; // attribute interleaved output when tiers run in parallel
  const session = await new BoltEngine(liveBoltDriver({ systemPrompt })).startSession(target, { provider, model });
  let ok = true;
  try {
    for await (const ev of session.prompt(prompt)) {
      if (ev.type === "thinking") console.log(`… ${tag}${ev.text}`);
      else if (ev.type === "message") console.log(`${tag}${ev.text}`);
      else if (ev.type === "file-changed") console.log(`  ${tag}${ev.action}: ${ev.path}`);
      else if (ev.type === "error") {
        console.error(`${tag}generation error: ${ev.message}`);
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
    console.log("\n🛑 BLOCK — fix or escalate (vibehard escalate <dir>)");
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

/** Build an app from its architecture: generate workstreams in dependency-tier order. Tiers run
 *  STRICTLY sequentially (tier N+1 depends on tier N's files via `built`); workstreams WITHIN a
 *  tier are independent (buildOrder guarantees it), so they run concurrently, capped by
 *  VIBEHARD_CODEGEN_CONCURRENCY (default 4) so the fan-out never overruns provider limits. Each
 *  workstream is a scoped engine pass that accumulates files into `target`. */
/** Deterministic layout safety net: codegen sometimes points the `@/*` import alias at `./src/*`
 *  while placing files at the root (or vice versa), which makes every `@/...` import fail to
 *  resolve and BLOCKS the build. Correct the alias to wherever the source actually lives. */
function normalizeLayout(target: string): void {
  const tscPath = join(target, "tsconfig.json");
  if (!existsSync(tscPath)) return;
  try {
    const j = JSON.parse(readFileSync(tscPath, "utf8")) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    const rootHasSrc = ["components", "app", "lib"].some((d) => existsSync(join(target, d)));
    const underSrc = ["components", "app", "lib"].some((d) => existsSync(join(target, "src", d)));
    let want: string | null = null;
    if (rootHasSrc && !underSrc) want = "./*";
    else if (underSrc && !rootHasSrc) want = "./src/*";
    if (!want) return; // mixed/unknown → leave it for the gate to flag
    const opts = (j.compilerOptions ??= {});
    const paths = (opts.paths ??= {});
    if ((Array.isArray(paths["@/*"]) ? paths["@/*"][0] : undefined) === want) return;
    paths["@/*"] = [want];
    opts.baseUrl ??= ".";
    writeFileSync(tscPath, JSON.stringify(j, null, 2));
    console.log(`  ▸ layout: fixed the @/* import alias → ${want} (matches where the files are)`);
  } catch {
    /* unparseable tsconfig → leave it; the verify gate will still catch a real break */
  }
}

/** Deterministically scaffold the boilerplate the model keeps botching: the Tailwind/PostCSS
 *  config (a duplicated/malformed postcss config held a build this cycle). Boilerplate is
 *  identical every app, so write it in code rather than trust the LLM. Idempotent. */
function scaffoldConfigs(target: string): void {
  const pkgPath = join(target, "package.json");
  if (!existsSync(pkgPath)) return;
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return;
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const usesTailwind = !!deps.tailwindcss || !!deps["@tailwindcss/postcss"] || existsSync(join(target, "tailwind.config.ts")) || existsSync(join(target, "tailwind.config.js"));
  if (!usesTailwind) return;
  // collapse to ONE canonical config — duplicate/conflicting postcss files break the build
  for (const f of ["postcss.config.js", "postcss.config.cjs", "postcss.config.ts", "postcss.config.json"]) {
    const p = join(target, f);
    if (existsSync(p)) rmSync(p);
  }
  const v4 = !!deps["@tailwindcss/postcss"] || /\b4\./.test(String(deps.tailwindcss ?? "").replace(/^[^\d]*/, "4."));
  const config = v4
    ? `export default {\n  plugins: {\n    "@tailwindcss/postcss": {},\n  },\n};\n`
    : `export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n};\n`;
  writeFileSync(join(target, "postcss.config.mjs"), config);
  // a v3 config needs autoprefixer + postcss installed (config-only deps the import scan can't see)
  if (!v4) {
    const dd = (pkg.devDependencies ??= {});
    let changed = false;
    if (!deps.autoprefixer) (dd.autoprefixer = "^10.4.20"), (changed = true);
    if (!deps.postcss) (dd.postcss = "^8.4.49"), (changed = true);
    if (changed) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  }
  console.log("  ▸ scaffold: wrote a clean postcss.config.mjs (boilerplate is deterministic, not generated)");
}

async function buildFromArchitecture(target: string, arch: Architecture, provider: string, model: string): Promise<boolean> {
  // Pick the codegen prompt for this architecture's stack (Python/FastAPI → the Python
  // prompt; else the TS/Supabase one). VIBEHARD_LANG=python forces it, for deliberately
  // building/validating a Python app.
  // #12: inject the chosen design preset (VIBEHARD_DESIGN) into the frontend codegen so every screen
  // inherits a consistent, professional look. Python (FastAPI API) has no UI, so no design block.
  // Inject the FLEET learning store's codegen conventions (private; system-prompt only — never
  // shipped to the user). This is now the single source for what used to be hardcoded conventions.
  const systemPrompt = (process.env.VIBEHARD_LANG === "python" ? PYTHON_SYSTEM_PROMPT : selectSystemPrompt(arch.stack) + designBlock()) + fleetBlock(arch.stack, "codegen");
  const concurrency = Math.max(1, Number(process.env.VIBEHARD_CODEGEN_CONCURRENCY) || 4);
  // runTiers keeps tiers sequential + workstreams within a tier concurrent (≤cap). `built` (the
  // prior-tiers snapshot) is mapped to names for the brief — identical to sequential codegen.
  return runTiers(
    buildOrder(arch),
    concurrency,
    (ws, built) => {
      console.log(`\n  ▸ workstream: ${ws.name} — ${ws.files.length} file(s)`);
      return streamGeneration(target, workstreamBrief(arch, ws, built.map((w) => w.name)), provider, model, systemPrompt, ws.name);
    },
    (tier) => {
      if (tier.length > 1) console.log(`\n  ▸ tier: ${tier.length} independent workstreams in parallel (≤${concurrency}) — ${tier.map((w) => w.name).join(", ")}`);
    },
  );
}

/** Print a gate's result the moment it lands — readable for a human, and machine-parseable for the
 *  web dashboard (it keys on the `gate: <glyph> <name>` shape to drive a per-gate checklist). */
function printGateVerdict(v: { gate: string; status: string; blocking: number }): void {
  const glyph = v.status === "pass" ? "✓" : v.status === "block" ? "✗" : "⚠";
  console.log(`  gate: ${glyph} ${v.gate}${v.status === "pass" ? "" : ` (${v.blocking} blocking)`}`);
}

/** Gate → auto-fix → re-gate; report green on success, or HOLD + queue for human
 *  review on exhaustion (§24). Returns the exit code. Shared by `fix` and `build`. */
async function runAutoFixAndReport(target: string): Promise<number> {
  // No live human layer is wired yet (only the async local queue — no synchronous
  // reviewer), so no human is "available" → the loop runs its extra no-human attempts
  // before holding, rather than parking a stuck build for an absent human. When the
  // GitHub/Slack adapter lands (§24), this becomes a real availability check.
  const result = await autoFix(target, {
    onStep: (m) => console.log(`  … ${m}`),
    gate: (p) => runGate(p, undefined, printGateVerdict), // emit each gate's pass/fail live
    humanAvailable: async () => false,
  });
  if (result.fixed) {
    console.log(`\n✅ gate green after ${result.attempts} auto-fix attempt(s) — deploy-ready.`);
    return 0;
  }
  console.log(`\n🛑 auto-fix could not resolve everything in ${result.attempts} attempt(s).`);
  if (result.escalation) {
    const ticket = await localSink().open(result.escalation);
    await notifier().notifyOpened(ticket); // best-effort reviewer ping
    console.log(`  ::held ${ticket.id}`); // machine-parseable: links this build to its review ticket
    console.log(`   → held for human review (needs-human): ticket ${ticket.id}`);
    console.log(`   queued at ${queuePath()} — list with: vibehard queue`);
  }
  console.log("\n   residual blocking findings:");
  for (const v of result.finalVerdicts) for (const f of v.findings) explainFinding(f);
  return 1;
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

  if (cmd === "tenant") {
    const [, sub, name] = argv;
    const platform = new Platform();
    if (sub === "signup") {
      if (!name) {
        console.error('usage: vibehard tenant signup "<name>" [plan]');
        return 2;
      }
      const t = platform.signUp(name, argv[3] ?? "free");
      console.log(`✅ tenant ${t.id} created — ${t.name} [${t.plan}], ${t.status}`);
      console.log(`   isolated state dir: ${platform.stateDir(t.id)}`);
      return 0;
    }
    if (sub === "list") {
      const tenants = platform.listTenants();
      if (!tenants.length) {
        console.log('no tenants yet — `vibehard tenant signup "<name>"`');
        return 0;
      }
      for (const t of tenants) {
        console.log(`${t.id}  ${t.name}  [${t.plan}]  ${t.status}  ${platform.projectCount(t.id)}/${planFor(t).maxProjects} projects`);
      }
      return 0;
    }
    if (sub === "show" && name) {
      const t = platform.getTenant(name);
      if (!t) {
        console.error(`no tenant "${name}"`);
        return 1;
      }
      console.log(JSON.stringify({ ...t, projects: platform.projectCount(t.id), projectLimit: planFor(t).maxProjects }, null, 2));
      return 0;
    }
    if (sub === "deploy") {
      const [, , tid, dir] = argv;
      if (!tid || !dir) {
        console.error("usage: vibehard tenant deploy <tenant-id> <dir>   (quota-checked; provisions the tenant's OWN project + deploys)");
        return 2;
      }
      try {
        const outcome = await platform.deployForTenant(tid, resolve(dir), { onStep: (m) => console.log(`   · ${m}`) });
        if (outcome.live) {
          console.log(`\n✅ LIVE → ${outcome.url}`);
          return 0;
        }
        console.log(`\n🛑 aborted at "${outcome.abortedAt}": ${outcome.reason}`);
        return 1;
      } catch (e) {
        console.error(`🛑 ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    if (sub === "build") {
      const [, , tid, app, dir] = argv;
      if (!tid || !app || !dir) {
        console.error("usage: vibehard tenant build <tenant-id> <app> <dir>   (quota-checked; gate→fix→re-gate; holds escalate)");
        return 2;
      }
      const repo = process.env.VIBEHARD_ESCALATION_REPO;
      const sink = repo ? new GitHubEscalationSink({ repo }) : new LocalEscalationSink(join(homedir(), ".vibehard", "escalations"));
      const runner = new LocalBuildRunner({ sink, onStep: (m) => console.log(`   · ${m}`) });
      try {
        const job = await platform.build(tid, app, runner, resolve(dir));
        console.log(`\n${job.status === "succeeded" ? "✅" : "🛑"} build ${job.id} → ${job.status}${job.error ? ` — ${job.error}` : ""}`);
        return job.status === "succeeded" ? 0 : 1;
      } catch (e) {
        console.error(`🛑 ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
    if (sub === "usage" && name) {
      const events = platform.usage(name);
      if (!events.length) {
        console.log("no usage recorded");
        return 0;
      }
      for (const e of events) console.log(`${e.at}  ${e.kind}${e.app ? `  ${e.app}` : ""}`);
      return 0;
    }
    if (sub === "builds" && name) {
      const builds = platform.listBuilds(name);
      if (!builds.length) {
        console.log("no builds");
        return 0;
      }
      for (const b of builds) console.log(`${b.id}  ${b.status}  ${b.app}  ${b.queuedAt}${b.error ? `  — ${b.error}` : ""}`);
      return 0;
    }
    console.error("usage: vibehard tenant <signup|list|show|deploy|build|usage|builds>");
    return 2;
  }

  if (cmd === "gate" || cmd === "deploy") {
    if (!arg) {
      console.error(`usage: vibehard ${cmd} <dir>`);
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

  if (cmd === "intake") {
    const [, promptText] = argv;
    if (!promptText) {
      console.error('usage: vibehard intake "<prompt>"');
      return 2;
    }
    // grill-me (backlog #1): a real INTERVIEW — one question at a time, each with a suggested answer
    // (press Enter to accept). Branches on prior answers, stops when clear. OPTIONAL/fail-safe.
    const interviewer = llmInterviewer();
    const turns: InterviewTurn[] = [];
    console.log("A few quick questions so we build the right thing (press Enter to accept the suggestion):\n");
    while (turns.length < MAX_QUESTIONS) {
      const step = await interviewer(promptText, turns);
      if (step.done || !step.question) break;
      const q = step.question;
      console.log(q.question);
      // Multiple-choice: tap a number (★ = recommended), or type your own answer.
      q.options.forEach((o, i) => {
        const star = o.label === q.recommended ? " ★" : "";
        console.log(`  ${i + 1}. ${o.label}${star}${o.detail ? ` — ${o.detail}` : ""}`);
      });
      const raw = (prompt(q.options.length ? `  pick 1-${q.options.length}, or type your own [${q.recommended}] > ` : `  [suggested: ${q.recommended}] > `) || "").trim();
      const picked = raw && /^\d+$/.test(raw) && q.options[Number(raw) - 1];
      const answer = picked ? picked.label : raw || q.recommended;
      turns.push({ question: q.question, answer });
      console.log("");
    }
    if (!turns.length) {
      console.log("No questions — this is simple enough to build as described.");
      return 0;
    }
    console.log(`\nHere's what I'll build:\n${foldInterview(promptText, turns)}`);
    return 0;
  }

  if (cmd === "plan") {
    const [, promptText] = argv;
    if (!promptText) {
      console.error('usage: vibehard plan "<prompt>"');
      return 2;
    }
    // Front-half (§22): the LLM drafts a PRD, the deterministic readiness check grills
    // it, and it re-drafts to resolve blocking gaps — bounded. Spec proposed, gate disposes.
    const provider = providerOf();
    const model = modelForStage("spec");
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
      console.log(`\n✅ spec ready to build (after ${result.rounds} round(s)) — next: vibehard generate "<this app>" <dir>`);
      return 0;
    }
    console.log(`\n🛑 spec NOT ready after ${result.rounds} round(s) — these need clarifying first:`);
    for (const f of result.gaps.filter(isBlocking)) explainFinding(f);
    return 1;
  }

  if (cmd === "build") {
    const [, promptText, dir] = argv;
    if (!promptText || !dir) {
      console.error('usage: vibehard build "<prompt>" <dir>');
      return 2;
    }
    const target = resolve(dir);
    const provider = providerOf();
    const onStep = (m: string) => console.log(`  … ${m}`);
    // Per-stage, right-fit models (codegen + fix get the strong code model; planning a reasoning
    // model; advisory a light one). Visible up front so it's clear which LLM runs at which stage.
    console.log("models per stage:");
    for (const { stage, model } of modelPlan()) console.log(`  ${stage.padEnd(10)} ${provider}/${model}`);

    // The full pipeline (§22 front-half → back-half). RESUMABLE: every finished stage's artifact
    // is loaded from .vibehard/ on a re-run, so a stopped/paused build continues where it left off
    // (no re-spend). Each front-half stage's deterministic review must still pass before the next.
    if (existsSync(join(target, ".vibehard", "spec.json"))) {
      console.log("↻ resuming this build — finished stages load from saved work instead of re-running.\n");
    }

    // 1. intake → spec
    let spec = loadStage<Spec>(target, "spec.json");
    if (spec) {
      console.log(`✓ spec — restored from saved work (${spec.features.length} feature(s))`);
    } else {
      console.log(`drafting the spec with ${provider}/${modelForStage("spec")} …`);
      const plan = await planIntake(promptText, { intake: llmIntake({ config: configForStage("spec") }), onStep });
      printSpec(plan.spec);
      console.log(`   rigor: ${decideRigor(plan.spec)} (§16 adaptive)`);
      for (const f of plan.gaps.filter((g) => !isBlocking(g))) explainFinding(f);
      if (!plan.ready) {
        console.log("\n🛑 spec not ready — clarify and retry:");
        for (const f of plan.gaps.filter(isBlocking)) explainFinding(f);
        return 1;
      }
      persistSpec(target, plan.spec); // durable classification for the compliance gate (§21)
      spec = plan.spec;
    }

    // 2. spec → PRD — a Principal-PM document (one-pager, personas, scenarios, scoped + prioritised
    //    features with acceptance criteria, metrics, risks). NFRs + buy-vs-build are DERIVED (§11).
    let prd = loadStage<Prd>(target, "prd.json");
    if (prd) {
      console.log(`✓ product requirements (PRD) — restored from saved work (${prd.requirements.length} feature(s))`);
    } else {
      console.log("\n── writing the product requirements (PRD) … ──");
      const prdRes = await elaboratePrd(spec, { elaborator: llmElaborator({ config: configForStage("prd") }), onStep });
      prd = prdRes.prd;
      console.log(
        `   ${prd.requirements.length} feature(s) (${prd.requirements.filter((r) => r.priority === "MVP").length} MVP) · ${prd.objectives.length} objective(s) · ${prd.personas.length} persona(s) · ${prd.scenarios.length} scenario(s) · ${prd.successMetrics.length} metric(s) · ${prd.nfrs.length} security NFR(s)`,
      );
      for (const b of prd.buyVsBuild) console.log(`   💡 buy-vs-build: ${b.category} → consider ${b.service} (advisory)`);
      for (const f of prdRes.gaps.filter((g) => !isBlocking(g))) explainFinding(f); // advisory PM-quality nudges
      if (!prdRes.ready) {
        console.log("\n🛑 PRD not complete:");
        for (const f of prdRes.gaps.filter(isBlocking)) explainFinding(f);
        return 1;
      }
      persistPrd(target, prd);
      console.log(`   📄 PRD written → ${join(target, "PRD.md")}`);
    }

    // 3. PRD → SRS — a Principal-Systems-Architect document (strict per-module I/O specs, quantified
    //    NFRs, flagged unknowns). Operating env / security / compliance are DERIVED (§11).
    let srs = loadStage<Srs>(target, "srs.json");
    if (srs) {
      console.log(`✓ technical spec (SRS) — restored from saved work (${srs.functionalRequirements.length} requirement(s))`);
    } else {
      console.log("\n── detailing the technical spec (SRS) … ──");
      const srsRes = await elaborateSrs(prd, { specifier: llmSpecifier({ config: configForStage("srs") }), onStep });
      srs = srsRes.srs;
      console.log(
        `   ${srs.functionalRequirements.length} functional requirement(s) · ${srs.apiInterfaces.length} interface(s) · ${srs.openIssues.length} open issue(s) flagged`,
      );
      for (const f of srsRes.gaps.filter((g) => !isBlocking(g))) explainFinding(f); // advisory rigor nudges
      if (!srsRes.ready) {
        console.log("\n🛑 SRS not complete:");
        for (const f of srsRes.gaps.filter(isBlocking)) explainFinding(f);
        return 1;
      }
      persistSrs(target, srs);
      console.log(`   📄 SRS written → ${join(target, "SRS.md")}`);
    }

    // 4. SRS → architecture / SAD (workstream dependency graph, designed against the SRS)
    let arch = loadStage<Architecture>(target, "architecture.json");
    if (arch) {
      arch = { ...arch, prd, srs }; // re-attach the prd/srs stripped on persist
      console.log(`✓ architecture (SAD) — restored from saved work (${arch.workstreams.length} component(s))`);
    } else {
      console.log("\n── designing the architecture (SAD) … ──");
      const archRes = await architectApp(prd, { architect: llmArchitect({ config: configForStage("sad") }), srs, onStep });
      if (!archRes.ready) {
        console.log("\n🛑 architecture not buildable:");
        for (const f of archRes.gaps.filter(isBlocking)) explainFinding(f);
        return 1;
      }
      arch = archRes.arch;
      const tiers = buildOrder(arch);
      console.log(`   ${arch.stack} · ${arch.workstreams.length} workstream(s) in ${tiers.length} tier(s): ${tiers.map((t) => t.map((w) => w.name).join("+")).join(" → ")}`);
      persistSad(target, arch);
      console.log(`   📄 SAD written → ${join(target, "SAD.md")}`);
    }

    // 5. adversarial plan review + codegen — skipped together once the code has been generated.
    const builtMarker = join(target, ".vibehard", "built.json");
    if (existsSync(builtMarker)) {
      console.log("✓ generated code — restored from saved work");
    } else {
      // Adversarial review of the PLAN before codegen: deterministic cross-checks (can block) +
      // an LLM red-team (advisory; serious findings flagged for a human; production rigor only).
      console.log("\n── reviewing the plan for risks (adversarial) … ──");
      const review = await reviewFrontHalf(
        { spec, prd, architecture: arch },
        { adversary: decideRigor(spec) === "production" ? llmAdversary({ config: configForStage("review") }) : undefined },
      );
      for (const fdg of [...review.crossChecks, ...review.adversarial]) explainFinding(fdg);
      if (review.blocked) {
        console.log("\n🛑 the plan is internally inconsistent — fix the spec / PRD / architecture before building.");
        return 1;
      }
      if (review.needsHuman.length) {
        console.log(`\n⚠️  ${review.needsHuman.length} risk(s) a reviewer should weigh (advisory — not blocking the build).`);
      }

      // Build each component from the plan, in dependency order.
      console.log(`\n── writing the code with ${provider}/${modelForStage("codegen")} → ${target} ──`);
      if (!(await buildFromArchitecture(target, arch, provider, modelForStage("codegen")))) return 1;
      normalizeLayout(target); // deterministic safety net: make the @/* alias match where files live
      scaffoldConfigs(target); // deterministic boilerplate (postcss/tailwind) — never LLM-generated
      // Deterministic design system: write the chosen preset's theme + globals so the look is
      // GUARANTEED premium, not left to the model (which diluted prompt-only presets to generic gray).
      const ds = scaffoldDesignSystem(target);
      if (ds.applied) console.log(`  ▸ scaffold: applied the "${ds.preset}" design system (themed tailwind + globals.css — premium by default)`);
      writeFileSync(builtMarker, JSON.stringify({ at: new Date().toISOString() }));
    }

    // Seed the as-built journal (idempotent) — "intended" from planning; the gate→fix loop
    // then appends what actually happened. The fixer reads it to avoid repeating failed fixes.
    seedJournal(target, { name: spec.name, summary: spec.summary, stack: typeof arch.stack === "string" ? arch.stack : JSON.stringify(arch.stack ?? "Next.js + Supabase") });

    // 6. back-half: security checks (gates) → auto-fix → hold-for-review (always run — the verifier)
    console.log("\n── running the security checks (gates) + auto-fixing … ──");
    return runAutoFixAndReport(target);
  }

  if (cmd === "generate") {
    const [, promptText, dir] = argv;
    if (!promptText || !dir) {
      console.error('usage: vibehard generate "<prompt>" <dir>');
      return 2;
    }
    // Generate live, then auto-gate the freshly generated code (PROJECT_BRIEF.md §8 "Option A").
    const target = resolve(dir);
    // Provider/model selection: explicit override wins; else opencode when its key is
    // present, otherwise anthropic. Logged so the choice is never silent.
    const provider = providerOf();
    const model = modelForStage("codegen");
    console.log(`generating with ${provider}/${model} → ${target}`);
    // VIBEHARD_LANG=python → the Python (FastAPI + Supabase + Dockerfile) codegen prompt.
    const sysPrompt = process.env.VIBEHARD_LANG === "python" ? PYTHON_SYSTEM_PROMPT : undefined;
    if (!(await streamGeneration(target, promptText, provider, model, sysPrompt))) return 1; // don't gate a half-built app
    console.log(`\n── gating generated app at ${target} ──`);
    return (await gateAndReport(target)) ? 0 : 1;
  }

  if (cmd === "fix") {
    if (!arg) {
      console.error("usage: vibehard fix <dir>");
      return 2;
    }
    const target = resolve(arg);
    console.log(`auto-fixing ${target} (gate → fix → re-gate, bounded) …`);
    return runAutoFixAndReport(target);
  }

  if (cmd === "fleet") {
    // The operator's view into fleet learning (the human-in-the-loop gate). Never user-facing.
    const sub = argv[1];
    if (sub === "induct") {
      console.log("inducing conventions from promotable candidates (recurring failures + the fixes that cleared them) …");
      const proposed = await runInduction();
      console.log(`\n${proposed.length} new proposal(s) staged for review:`);
      for (const c of proposed) console.log(`  • ${c.id} [${c.phase}] — addresses ${c.addresses}\n      ${c.rule}`);
      const pend = pendingConventions();
      console.log(`\n${pend.length} total pending. Approve with: vibehard fleet approve <id>`);
      return 0;
    }
    if (sub === "list") {
      const pend = pendingConventions();
      if (!pend.length) console.log("nothing pending review.");
      for (const c of pend) console.log(`pending: ${c.id} [${c.phase}] — ${c.rule}`);
      return 0;
    }
    if (sub === "approve") {
      const c = approveConvention(argv[2] ?? "");
      console.log(c ? `✓ approved '${c.id}' — now LIVE (injected into builds) + a regression fixture was dropped.` : `no pending convention with id '${argv[2]}'`);
      return c ? 0 : 1;
    }
    console.error("usage: vibehard fleet induct | list | approve <id>");
    return 2;
  }

  if (cmd === "diagnose") {
    if (!arg) {
      console.error("usage: vibehard diagnose <dir> [--build]");
      return 2;
    }
    const wantBuild = argv.includes("--build");
    const d = diagnose(resolve(arg), { build: wantBuild });
    console.log(formatDiagnosis(d));
    // exit non-zero when something is actionably wrong, so it's scriptable
    const broken = d.deps.undeclaredImports.length > 0 || d.deps.missingFromLock.length > 0 || d.build?.ok === false;
    return broken ? 1 : 0;
  }

  if (cmd === "refine") {
    const [, dir, change] = argv;
    if (!dir || !change) {
      console.error('usage: vibehard refine <dir> "<change request>"');
      return 2;
    }
    const target = resolve(dir);
    const provider = providerOf();
    const model = modelForStage("codegen");
    // Reuse the built app's codegen system prompt (stack-correct bolt protocol); the "only change
    // X, here's the current app" framing lives in the refine brief (src/refine/refine.ts).
    const arch = loadStage<Architecture>(target, "architecture.json");
    const systemPrompt = process.env.VIBEHARD_LANG === "python" ? PYTHON_SYSTEM_PROMPT : arch ? selectSystemPrompt(arch.stack) : undefined;
    console.log(`refining ${target} — incremental regen → re-gate → revert if it breaks a passing build …`);
    const result = await refine(target, change, {
      now: new Date().toISOString(),
      onStep: (m) => console.log(`  … ${m}`),
      regen: async (d, prompt) => {
        const written: string[] = [];
        const session = await new BoltEngine(liveBoltDriver({ systemPrompt })).startSession(d, { provider, model });
        let ok = true;
        try {
          for await (const ev of session.prompt(prompt)) {
            if (ev.type === "file-changed") {
              written.push(ev.path.replace(/^\/+/, "")); // normalize to the relative form listSourceFiles uses
              console.log(`  ${ev.action}: ${ev.path}`);
            } else if (ev.type === "thinking") console.log(`… ${ev.text}`);
            else if (ev.type === "error") {
              console.error(`generation error: ${ev.message}`);
              ok = false;
            }
          }
        } finally {
          await session.dispose();
        }
        return { ok, filesWritten: written };
      },
    });
    if (result.restored) {
      console.log("\n↩️  refine reverted — it broke the previously-passing gate and auto-fix couldn't recover it. Your app is unchanged.");
      return 1;
    }
    if (!result.accepted) {
      console.log("\n🛑 refine did not complete (engine error) — see above.");
      return 1;
    }
    console.log(`\n✅ refine applied — ${result.filesWritten.length} file(s) changed.`);
    console.log(result.gate.passed ? "   gate: ✅ PASS — deploy allowed" : "   gate: ⚠️  not green (the build was already not green before this refine) — run `vibehard gate` / `fix`");
    return result.gate.passed ? 0 : 1;
  }

  if (cmd === "refactor") {
    if (!arg) {
      console.error("usage: vibehard refactor <dir>");
      return 2;
    }
    const target = resolve(arg);
    // refactor-phase runs ONLY on a passing build — improving quality presupposes a
    // correct + secure starting point (§22). Confirm green before touching it.
    const pre = await runGate(target);
    if (!pre.passed) {
      console.log("🛑 refactor runs only on a PASSING build — gate it (and fix/escalate) first.");
      return 1;
    }
    const provider = providerOf();
    const model = modelForStage("refactor");
    const config = { provider, model };
    console.log("refactor-phase: score quality → refactor (behavior-preserving) → re-verify, revert on break …");
    const result = await refactorPhase(target, {
      scorer: llmScorer({ config }),
      refactorer: llmRefactorer({ config }),
      verify: (ws) => runGate(ws).then((r) => r.passed), // the deterministic disposer: must still pass ALL gates
      checkpoint: fileCheckpointer,
      onStep: (m) => console.log(`  … ${m}`),
    });
    for (const l of result.log) console.log(`  ${l}`);
    console.log(`\n✨ refactor-phase done — ${result.accepted} accepted, ${result.rejected} reverted (the passing build is preserved).`);
    return 0;
  }

  if (cmd === "polish") {
    if (!arg) {
      console.error("usage: vibehard polish <dir>   (art-director pass: improve the visual design, revert if it breaks)");
      return 2;
    }
    const target = resolve(arg);
    // Polish a PASSING build only — restyling presupposes a correct, shippable starting point (§22).
    const pre = await runGate(target);
    if (!pre.passed) {
      console.log("🛑 polish runs only on a PASSING build — gate it (and fix/escalate) first.");
      return 1;
    }
    const provider = providerOf();
    const model = modelForStage("polish");
    console.log("art-director: polishing the visual design → re-verify, revert if it breaks the build …");
    const result = await refactorPhase(target, {
      scorer: artDirectorScorer(),
      refactorer: artDirectorRefactorer({ config: { provider, model } }),
      verify: (ws) => runGate(ws).then((r) => r.passed), // the deterministic disposer: must still pass ALL gates
      checkpoint: fileCheckpointer,
      budget: 1, // one focused pass
      onStep: (m) => console.log(`  … ${m}`),
    });
    for (const l of result.log) console.log(`  ${l}`);
    console.log(result.accepted ? "\n✨ design polished — and it still passes every gate." : "\n↩️  polish reverted — it would have broken the build; your app is unchanged.");
    return 0;
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

  if (cmd === "reviewer") {
    const [, sub, ...rest] = argv;
    const store = reviewerStore();
    if (sub === "signup") {
      const name = rest[0];
      if (!name) {
        console.error(`usage: vibehard reviewer signup "<name>" [${SPECIALTIES.join("|")} …]`);
        return 2;
      }
      const { specialties, invalid } = parseSpecialties(rest.slice(1));
      if (invalid.length) {
        console.error(`unknown specialt${invalid.length > 1 ? "ies" : "y"}: ${invalid.join(", ")} — choose from ${SPECIALTIES.join(", ")}`);
        return 2;
      }
      const reviewer = makeReviewer(name, specialties, new Date().toISOString());
      try {
        store.create(reviewer);
      } catch (e) {
        console.error(`${e instanceof Error ? e.message : e}`);
        return 1;
      }
      console.log(`✅ reviewer registered: ${reviewer.id} — specialties: ${reviewer.specialties.join(", ")}`);
      console.log("   they'll be pinged when a packet routes to them (set VIBEHARD_SLACK_WEBHOOK to enable Slack).");
      return 0;
    }
    if (sub === "list" || sub === undefined) {
      const all = store.list();
      if (!all.length) {
        console.log('no reviewers yet — vibehard reviewer signup "<name>" <specialty…>');
        return 0;
      }
      console.log(`${all.length} reviewer(s):`);
      for (const r of all) console.log(`  ${r.id}  [${r.status}] — ${r.specialties.join(", ")}`);
      return 0;
    }
    console.error("usage: vibehard reviewer <signup|list>");
    return 2;
  }

  if (cmd === "claim") {
    const [, ticketId, reviewerId] = argv;
    if (!ticketId || !reviewerId) {
      console.error("usage: vibehard claim <ticket-id> <reviewer-id>");
      return 2;
    }
    const sink = localSink();
    const ticket = await sink.get(ticketId);
    if (!ticket) {
      console.error(`no such ticket: ${ticketId} — list with: vibehard queue`);
      return 1;
    }
    const reviewer = reviewerStore().get(reviewerId);
    if (!reviewer) {
      console.error(`no such reviewer: ${reviewerId} — register with: vibehard reviewer signup`);
      return 1;
    }
    // The routing moat: only a reviewer qualified for the packet's specialties may take it.
    if (!matchesPacket(reviewer, ticket.packet)) {
      console.error(`🛑 ${reviewer.id} (${reviewer.specialties.join(", ")}) is not qualified for this packet — it needs: ${ticket.packet.specialties.join(", ")}`);
      return 1;
    }
    try {
      const claimed = await sink.claim(ticketId, reviewer.id);
      console.log(`✅ ${claimed.id} claimed by ${reviewer.id} [${claimed.state}] — review it: vibehard review ${claimed.id}`);
      return 0;
    } catch (e) {
      console.error(`${e instanceof Error ? e.message : e}`);
      return 1;
    }
  }

  if (cmd === "review") {
    const [, ticketId] = argv;
    if (!ticketId) {
      console.error("usage: vibehard review <ticket-id>   (prints the scoped slice to judge)");
      return 2;
    }
    const ticket = await localSink().get(ticketId);
    if (!ticket) {
      console.error(`no such ticket: ${ticketId} — list with: vibehard queue`);
      return 1;
    }
    console.log(`${ticket.id} [${ticket.state}]${ticket.claimedBy ? ` · claimed by ${ticket.claimedBy}` : ""}`);
    console.log(`${ticket.packet.blocking} blocking · app: ${ticket.packet.workspacePath}`);
    for (const item of ticket.packet.items) {
      console.log(`\n── [${item.specialty}] ${item.finding.tool}:${item.finding.ruleId} — ${item.finding.message}`);
      console.log(`   ref: ${item.ref}`);
      if (item.slice) {
        console.log(`   ${item.slice.file}:${item.slice.startLine}-${item.slice.endLine}`);
        for (const line of item.slice.code.split("\n")) console.log(`   │ ${line}`);
      } else {
        console.log(`   (no slice — ${item.finding.file})`);
      }
    }
    console.log(`\n   resolve: vibehard resolve ${ticket.id} <approved|rejected|fixed> [justification]`);
    return 0;
  }

  if (cmd === "resolve") {
    const [, ticketId, verdictArg, ...justWords] = argv;
    if (!ticketId || !verdictArg) {
      console.error("usage: vibehard resolve <ticket-id> <approved|rejected|fixed> [justification]");
      return 2;
    }
    const verdict = verdictArg as ReviewVerdict;
    if (!["approved", "rejected", "fixed"].includes(verdict)) {
      console.error(`unknown verdict: ${verdictArg} — use approved | rejected | fixed`);
      return 2;
    }
    const justification = justWords.join(" ").trim() || undefined;
    // 'approved' downgrades a real finding to a waiver — it MUST carry a justification (audit + §11).
    if (verdict === "approved" && !justification) {
      console.error("🛑 'approved' requires a justification (it becomes an audited waiver): vibehard resolve <id> approved <why>");
      return 2;
    }
    const sink = localSink();
    const ticket = await sink.get(ticketId);
    if (!ticket) {
      console.error(`no such ticket: ${ticketId}`);
      return 1;
    }
    if (ticket.state !== "claimed" || !ticket.claimedBy) {
      console.error(`cannot resolve ${ticketId}: state is ${ticket.state} (claim it first: vibehard claim ${ticketId} <reviewer-id>)`);
      return 1;
    }
    const now = new Date().toISOString();
    const decisions: ReviewDecision[] = ticket.packet.items.map((item) => ({ ref: item.ref, verdict, reviewer: ticket.claimedBy!, justification, decidedAt: now }));
    if (!decisions.length) {
      console.error(`ticket ${ticketId} has no findings to decide`);
      return 1;
    }
    try {
      const resolved = await sink.resolve(ticketId, decisions);
      console.log(`✅ ${resolved.id} resolved [${resolved.state}] — ${decisions.length} finding(s) marked '${verdict}' by ${ticket.claimedBy}`);
      if (verdict === "approved") console.log("   → justified waiver(s) recorded; re-gate to lift the block (resume path).");
      else if (verdict === "fixed") console.log("   → re-gate to confirm the fix (the gate, not the human, confirms 'fixed').");
      else console.log("   → 'rejected' keeps the finding blocking — it stays until fixed.");
      return 0;
    } catch (e) {
      console.error(`${e instanceof Error ? e.message : e}`);
      return 1;
    }
  }

  if (cmd === "credentials") {
    if (!arg) {
      console.error("usage: vibehard credentials <dir>   (lists the third-party keys this app needs)");
      return 2;
    }
    const target = resolve(arg);
    const required = requiredCredentialsForApp(target);
    if (!required.length) {
      console.log("✅ No external credentials needed — this app runs on the Supabase backend VibeHard provisions.");
      return 0;
    }
    console.log(`This app needs ${required.length} credential(s) you provide (VibeHard handles the database):\n`);
    for (const c of required) {
      const have = process.env[c.key] ? " ✓ set" : "";
      console.log(`  ${c.key}${have}`);
      console.log(`    ${c.label} — ${c.help}`);
    }
    console.log("\nSet these in the environment before `vibehard ship`, and they're injected into the live app at runtime.");
    return 0;
  }

  if (cmd === "functest") {
    if (!arg) {
      console.error("usage: vibehard functest <dir>   (LLM QA: does the app implement the features you asked for?)");
      return 2;
    }
    const target = resolve(arg);
    const spec = loadStage<Spec>(target, "spec.json");
    const features = spec?.features ?? [];
    if (!features.length) {
      console.error("no feature list in .vibehard/spec.json — build the app first.");
      return 2;
    }
    const provider = providerOf();
    const model = modelForStage("functest");
    console.log(`functional review: checking the app implements ${features.length} feature(s) …`);
    let checks;
    try {
      checks = await llmFunctionalReviewer({ config: { provider, model } })(features, target);
    } catch (e) {
      console.error(`couldn't review: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    if (!checks.length) {
      console.log("couldn't review (no readable app code).");
      return 1;
    }
    const ICON: Record<string, string> = { works: "✅", partial: "🟠", missing: "🔴" };
    for (const c of checks) {
      console.log(`  ${ICON[c.status]} ${c.feature}`);
      if (c.note) console.log(`     ${c.note}`);
    }
    const s = summarize(checks);
    console.log(`\n${s.works}/${s.total} working · ${s.partial} partial · ${s.missing} missing  (advisory — not a gate)`);
    return 0;
  }

  if (cmd === "prod-scan") {
    if (!arg) {
      console.error("usage: vibehard prod-scan <path-to-app.jsonl>");
      return 2;
    }
    // §20 production back-edge: scan a deployed app's logs for anomalies → feedback
    // packets. NON-BLOCKING (always exits 0) — it feeds the next iteration, never gates.
    const result = runProdScan(resolve(arg), { now: new Date().toISOString() });
    console.log(`prod-feedback scan — ${result.high} high, ${result.medium} medium`);
    for (const p of result.packets) {
      const subject = p.route ? ` ${p.route}` : p.source ? ` ${p.source}` : "";
      console.log(`\n  ${SEV_DOT[p.severity]} ${p.anomaly_type}${subject}`);
      console.log(`     ${p.measured}`);
      console.log(`     → ${p.suggested_fix_focus}`);
    }
    console.log(`\n  HIGH → ${result.buildStatusPath}`);
    console.log(`  MEDIUM → ${result.prodNotesPath}`);
    console.log("  (non-blocking — the production back-edge, not a deploy gate)");
    return 0;
  }

  if (cmd === "ship") {
    if (!arg) {
      console.error("usage: vibehard ship <dir>   (gates, then provisions a backend + deploys to a live URL)");
      return 2;
    }
    const dir = resolve(arg);
    // 1. gate FIRST — never deploy unverified code (writes the HARD_VERIFY_PASS sentinel on pass)
    console.log("── gating before deploy ──");
    const gate = await deployGate(dir);
    for (const v of gate.verdicts) console.log(`   ${v.status === "pass" ? "✅" : "🛑"} ${v.gate}`);
    if (!gate.passed) {
      console.log("\n🛑 BLOCK — not deploying. Fix or escalate first (vibehard escalate <dir>).");
      return 1;
    }
    // 2. provision (customer-owned Supabase) → migrate → VERIFY LIVE RLS → deploy (Vercel) → live URL
    console.log("\n── provisioning + deploying ──");
    try {
      const outcome = await deployApp(dir, { onStep: (m) => console.log(`   · ${m}`) });
      if (outcome.live) {
        console.log(`\n✅ LIVE → ${outcome.url}`);
        return 0;
      }
      console.log(`\n🛑 deploy aborted at "${outcome.abortedAt}": ${outcome.reason}`);
      return 1;
    } catch (e) {
      console.error(`\n🛑 deploy failed: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  if (cmd === "research") {
    if (!arg) {
      console.error("usage: vibehard research <dir>   (reads .vibehard/spec.json; ONLINE — queries npm + deps.dev)");
      return 2;
    }
    // §22 full make-vs-buy advisor: discover OSS + service candidates, vet them on
    // deterministic evidence (license / advisories / maintenance / OpenSSF Scorecard),
    // rank, and summarize. ONLINE + OPT-IN — keyless (npm + deps.dev), NOT a gate. It
    // never auto-installs; anything actually adopted still passes the security gates.
    const specPath = join(resolve(arg), ".vibehard", "spec.json");
    if (!existsSync(specPath)) {
      console.error(`no .vibehard/spec.json in ${arg} — run \`vibehard plan\` or \`build\` first so there's a spec to research.`);
      return 2;
    }
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as Spec;
    const caps = capabilitiesFromSpec(spec);
    if (!caps.length) {
      console.log(`No commodity capabilities detected in "${spec.name}" — nothing obvious to procure (it's bespoke). Build it; the gates will vet the result.`);
      return 0;
    }
    const hasKey = !!(process.env.OPENCODE_API_KEY || process.env.ANTHROPIC_API_KEY);
    console.log(`\n🔎 researching ${caps.length} capabilit${caps.length === 1 ? "y" : "ies"} for "${spec.name}" — querying npm + deps.dev (licenses, advisories, OpenSSF Scorecard)…`);
    console.log(`   make-vs-buy advisory — VibeHard never installs or procures for you${hasKey ? "" : "  ·  no LLM key → deterministic summaries"}.`);
    const advisories = await researchProcurement(caps, {
      candidateSource: combinedCandidateSource(registryCandidateSource, npmSearchCandidateSource({ limit: 5 })),
      evidenceProvider: depsDevEvidenceProvider(),
      summarizer: hasKey ? llmSummarizer() : undefined,
    });
    for (const a of advisories) printAdvisory(a);
    console.log("\n  (advisory only — you own the cost / data-residency / compliance decision; anything you adopt is re-checked by the gates)");
    return 0;
  }

  if (cmd === "escalate") {
    if (!arg) {
      console.error("usage: vibehard escalate <dir>");
      return 2;
    }
    const result = await runGate(arg);
    if (result.passed) {
      console.log("✅ no blocking findings — nothing to escalate");
      return 0;
    }
    const packet = await buildEscalationPacket(result.verdicts, arg);
    const ticket = await localSink().open(packet); // hold + queue for async human review (§24)
    await notifier().notifyOpened(ticket); // best-effort reviewer ping (Slack if VIBEHARD_SLACK_WEBHOOK set)
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
      "vibehard — safe vibe coding.",
      "",
      '  vibehard intake "<prompt>"           grill-me: the few clarifying questions a prompt needs first (advisory)',
      '  vibehard plan "<prompt>"             draft + grill a spec before building (front-half §22)',
      '  vibehard build "<prompt>" <dir>      full pipeline: spec → PRD → architecture → build → gate → fix → hold',
      '  vibehard generate "<prompt>" <dir>   generate an app from a raw prompt (engine only) + auto-gate it',
      "  vibehard gate <dir>                  run the security gate chain (report only)",
      "  vibehard deploy <dir>                run the chain + write the deploy sentinel iff all pass",
      "  vibehard ship <dir>                  gate → provision a customer-owned backend → verify live RLS → deploy → live URL",
      "  vibehard credentials <dir>           list the third-party keys this app needs (Stripe, OAuth, email)",
      "  vibehard fix <dir>                  auto-fix blocked findings (LLM + dep-bump), re-gate, else hold for review",
      '  vibehard refine <dir> "<change>"   iterate: apply a change, re-gate, revert if it breaks a passing build (§22)',
      "  vibehard refactor <dir>             improve code quality on a passing build; revert any change that breaks it (§22)",
      "  vibehard polish <dir>               art-director pass: improve the visual design on a passing build; revert if it breaks (#12)",
      "  vibehard functest <dir>             QA: does the built app implement the features you asked for? (works/partial/missing — advisory)",
      "  vibehard research <dir>            make-vs-buy advisor: discover + vet OSS/services (npm + deps.dev), advisory only (§22)",
      "  vibehard escalate <dir>             localize blocking findings into a routed review packet + queue it",
      "  vibehard queue [state]              list held escalations (needs-human | claimed | resolved)",
      '  vibehard reviewer signup "<name>" <specialty…>   register an SWE reviewer (security|database|reliability|general)',
      "  vibehard reviewer list             list registered reviewers",
      "  vibehard claim <ticket> <reviewer> claim a queued packet (refused unless the reviewer's specialty matches)",
      "  vibehard review <ticket>           print the scoped slice a reviewer judges",
      "  vibehard resolve <ticket> <approved|rejected|fixed> [why]   record the verdict (approved needs a justification)",
      "  vibehard prod-scan <app.jsonl>      scan a deployed app's logs for anomalies (§20 back-edge, non-blocking)",
      "",
      "Gates: verify · sast · secrets · depvuln · rls (PROJECT_BRIEF.md §8, §12).",
      "generate needs ANTHROPIC_API_KEY. Review queue dir: VIBEHARD_QUEUE_DIR (default ~/.vibehard/queue).",
    ].join("\n"),
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
