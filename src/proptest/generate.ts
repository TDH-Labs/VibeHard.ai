/**
 * Property-test generation (EPIC #53): after codegen, turn each MVP requirement's acceptance
 * criteria into a fast-check property test under tests/properties/. The LLM PROPOSES a test;
 * everything that decides whether it's kept is deterministic:
 *   • propTestVacuityReason — must import fast-check + an app module, assert ≥1 property,
 *     carry its requirement header, run with a FIXED seed, and not be skipped;
 *   • a real `bun test` run of the file — it must PASS against the just-generated app.
 *
 * Pass-at-generation makes the suite a REGRESSION RATCHET, not an initial-correctness oracle
 * (that's functest/completeness's job): once a criterion is encoded and green, no later fix
 * round or change request can break it — the proptest gate blocks, anti-tamper makes the test
 * itself untouchable, and the fixer is told the app (never the test) is what's wrong.
 * A requirement that can't get a valid passing test is SKIPPED with a journal-visible reason —
 * less coverage, never fake coverage.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateTextResilient, defaultModelFactory, type ModelFactory } from "../engine/bolt/driver.ts";
import type { EngineConfig } from "../types.ts";
import { configForStage } from "../config/models.ts";
import type { Requirement } from "../prd/index.ts";
import { PROPTEST_DIR, propTestFileName, propTestVacuityReason } from "./validate.ts";
import { DERIVED_DIRS } from "../gate/scan-scope.ts";

/** Bound the LLM cost per build: MVP requirements first, at most this many test files. */
export const MAX_PROPTEST_REQUIREMENTS = 6;
const SOURCE_BUDGET = 30_000;

const GEN_SYSTEM_PROMPT = `You write ONE fast-check property-based test file for a Next.js/TypeScript app.

Hard rules — a file violating any of them is rejected by a machine check:
- First line: \`// @requirement <ID>\` (the requirement id you are given).
- Import the test runner from "bun:test" and fast-check as \`import fc from "fast-check"\`.
- Import the app code under test by RELATIVE path from tests/properties/ (e.g. "../../lib/x") or the "@/" alias.
- At least one fc.assert(fc.property(...), { seed: 42, numRuns: 50 }) asserting a rule from the acceptance criteria that must hold for ALL generated inputs — not one example.
- Test PURE logic only: validation, calculation, formatting, state transitions. NO network, NO database, NO Supabase client, NO environment variables, NO React rendering.
- The test must PASS against the app source you are shown — you are encoding what the code already promises, so future changes can't silently break it.

If the acceptance criteria have no purely-testable rule (e.g. they are all about UI or the database), reply with exactly: SKIP

Otherwise reply with ONLY the TypeScript file content — no fences, no explanation.`;

export interface PropTestGenResult {
  written: string[];
  skipped: { id: string; reason: string }[];
}

export interface PropTestGenOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
  /** test seam: one model call (system, prompt) → raw text. */
  generate?: (system: string, prompt: string) => Promise<string>;
  /** test seam: run one test file, return exit + output. Default: `bun test <rel>` in the workspace. */
  runTest?: (projectPath: string, relFile: string) => { exitCode: number; output: string };
  /** test seam: refresh node_modules after the devDependency edit. Default: npm install. */
  install?: (projectPath: string) => number;
  maxRequirements?: number;
}

const defaultRunTest: NonNullable<PropTestGenOptions["runTest"]> = (projectPath, relFile) => {
  const p = Bun.spawnSync(["bun", "test", relFile], { cwd: projectPath, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  return { exitCode: p.exitCode ?? 1, output: `${p.stdout?.toString() ?? ""}${p.stderr?.toString() ?? ""}` };
};

const defaultInstall: NonNullable<PropTestGenOptions["install"]> = (projectPath) =>
  Bun.spawnSync(["npm", "install", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: projectPath, stdout: "ignore", stderr: "ignore" }).exitCode ?? 1;

/** Fallback when the app's own manifest can't install (observed live 2026-07-05: codegen's
 *  pre-fix-loop package.json was broken, so the full install failed and ALL property tests
 *  were skipped): install ONLY fast-check into tests/properties/node_modules — bun's module
 *  resolution finds it from the test files (nearest node_modules), and the app's own imports
 *  never see it. Works regardless of what state the app's dependency tree is in. */
function installFastCheckIsolated(projectPath: string): { ok: boolean; log: string } {
  const p = Bun.spawnSync(["npm", "install", "--prefix", "tests/properties", "--no-audit", "--no-fund", "--ignore-scripts", "--no-save", "fast-check@^4.0.0"], {
    cwd: projectPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: (p.exitCode ?? 1) === 0, log: `${p.stdout?.toString() ?? ""}${p.stderr?.toString() ?? ""}` };
}

/** Gather app source for the model: lib/ (pure logic) first, then the rest, capped. Paths + content. */
function gatherSource(root: string): string {
  const derived = new Set<string>(DERIVED_DIRS);
  const files: { rel: string; content: string }[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!derived.has(e.name) && e.name !== "tests") walk(join(dir, e.name), join(rel, e.name));
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        try {
          files.push({ rel: join(rel, e.name), content: readFileSync(join(root, dir, e.name), "utf8") });
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  walk(".", ".");
  files.sort((a, b) => Number(b.rel.startsWith("lib/")) - Number(a.rel.startsWith("lib/")));
  const out: string[] = [];
  let total = 0;
  for (const { rel, content } of files) {
    if (total >= SOURCE_BUDGET) break;
    total += content.length;
    out.push(`--- ${rel} ---\n${content}`);
  }
  return out.join("\n");
}

/** Ensure fast-check is importable from test files. Primary path: devDependency + full install
 *  (keeps the lockfile coherent — depbump pattern). Fallback: an ISOLATED install under
 *  tests/properties/node_modules, so one broken dependency elsewhere in the app's manifest
 *  can't zero out property-test coverage. Returns null on success, else the LOUD reason —
 *  "could not be installed" with no diagnostics cost a live debugging round (2026-07-05). */
function ensureFastCheck(root: string, install: NonNullable<PropTestGenOptions["install"]>): string | null {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return "the app has no package.json";
  let parseError: string | null = null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { devDependencies?: Record<string, string> };
    if (!pkg.devDependencies?.["fast-check"]) {
      pkg.devDependencies = { ...pkg.devDependencies, "fast-check": "^4.0.0" };
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    }
  } catch (e) {
    parseError = `package.json does not parse (${e instanceof Error ? e.message : String(e)})`;
  }
  if (!parseError) {
    if (existsSync(join(root, "node_modules", "fast-check"))) return null;
    if (install(root) === 0 && existsSync(join(root, "node_modules", "fast-check"))) return null;
  }
  // The app's own tree won't install (broken manifest / bad dep version) — isolate.
  const iso = installFastCheckIsolated(root);
  if (iso.ok) return null;
  return `${parseError ?? "the app's npm install failed"}; isolated fast-check install also failed: ${iso.log.slice(-300)}`;
}

const stripFences = (s: string): string => s.replace(/^```[a-z]*\n?/gm, "").replace(/```\s*$/gm, "").trim();

export async function generatePropertyTests(target: string, requirements: Requirement[], opts: PropTestGenOptions = {}): Promise<PropTestGenResult> {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config: EngineConfig = opts.config ?? configForStage("fix"); // code-critical → the strong code model
  const generate =
    opts.generate ??
    (async (system: string, prompt: string) => {
      const { text } = await generateTextResilient({ model: modelFactory(config), system, prompt, maxOutputTokens: 8000 }, { timeoutMs: 120_000 });
      return text;
    });
  const runTest = opts.runTest ?? defaultRunTest;
  const install = opts.install ?? defaultInstall;
  const max = opts.maxRequirements ?? MAX_PROPTEST_REQUIREMENTS;

  const result: PropTestGenResult = { written: [], skipped: [] };
  const picked = [...requirements.filter((r) => r.priority === "MVP"), ...requirements.filter((r) => r.priority !== "MVP")].slice(0, max);
  if (!picked.length) return result;

  const installProblem = ensureFastCheck(target, install);
  if (installProblem) {
    for (const r of picked) result.skipped.push({ id: r.id, reason: `fast-check could not be installed: ${installProblem}` });
    return result;
  }
  const source = gatherSource(target);
  mkdirSync(join(target, PROPTEST_DIR), { recursive: true });

  for (const r of picked) {
    const rel = join(PROPTEST_DIR, propTestFileName(r.id));
    const ask = [
      `Requirement ${r.id}: ${r.feature}`,
      `Detail: ${r.detail}`,
      `Acceptance criteria:`,
      ...r.acceptance.map((a) => `- ${a}`),
      ``,
      `App source (test file will live at ${rel}):`,
      source,
    ].join("\n");

    let reason: string | null = null;
    let feedback = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      let raw: string;
      try {
        raw = stripFences(await generate(GEN_SYSTEM_PROMPT, ask + feedback));
      } catch (e) {
        reason = `model call failed: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
      if (/^SKIP\b/.test(raw)) {
        reason = "model judged no acceptance criterion purely testable";
        break;
      }
      const vacuous = propTestVacuityReason(raw);
      if (vacuous) {
        reason = `invalid test: ${vacuous}`;
        feedback = `\n\nYour previous attempt was rejected: ${vacuous}. Produce a corrected file.`;
        continue;
      }
      writeFileSync(join(target, rel), raw);
      const run = runTest(target, rel);
      if (run.exitCode === 0) {
        result.written.push(rel);
        reason = null;
        break;
      }
      // Failing at generation = the test mis-encodes the app (or the module path is wrong) —
      // never ship a red ratchet. Feed the error back once, then drop.
      rmSync(join(target, rel), { force: true });
      reason = `test did not pass against the generated app: ${run.output.slice(-300)}`;
      feedback = `\n\nYour previous attempt failed when run:\n${run.output.slice(-1500)}\nProduce a corrected file that PASSES against the app source shown.`;
    }
    if (reason) result.skipped.push({ id: r.id, reason });
  }
  return result;
}
