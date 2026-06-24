/**
 * Art-director pass (backlog #12, part 2). After codegen, a senior-designer LLM polishes the
 * app's VISUAL design to the chosen preset — layout, spacing, type, color, component styling,
 * empty/loading states, responsiveness — WITHOUT touching behavior. It plugs into the proven
 * refactor-phase machinery (checkpoint → change → re-verify → revert on break), so a polish that
 * would break the build is reverted: "the passing build is sacred" applies to design too.
 *
 * The scorer is deterministic (the UI files ARE the targets — no LLM needed to decide design is
 * worth doing); the refactorer is the live engine pass. Provider/model is single-sourced like the
 * refactor + auto-fix passes.
 */
import { readAppSources } from "../gate/rls.ts";
import { configForStage } from "../config/models.ts";
import type { EngineConfig } from "../types.ts";
import { defaultModelFactory, liveBoltDriver, type ModelFactory } from "../engine/bolt/driver.ts";
import { BoltEngine } from "../engine/bolt/engine.ts";
import type { Refactorer, Scorer } from "../refactor/refactor.ts";
import { designPreset } from "./presets.ts";

const UI_EXT = [".tsx", ".jsx", ".vue", ".svelte", ".html", ".css", ".scss", ".astro"];
const isUi = (file: string): boolean => UI_EXT.some((e) => file.endsWith(e));

/** Deterministic: the app's UI files are the polish targets (empty → nothing to do, phase stops). */
export function artDirectorScorer(): Scorer {
  return async (workspace) => {
    const ui = (await readAppSources(workspace)).filter((s) => isUi(s.file));
    if (!ui.length) return { targets: [], summary: "no UI files to polish" };
    return { targets: ui.map((s) => ({ file: s.file, issue: "polish the visual design to the chosen look" })), summary: `${ui.length} UI file(s)` };
  };
}

const SOURCE_CAP = 80_000;
function uiBlock(ui: Array<{ file: string; code: string }>): string {
  const out: string[] = [];
  let total = 0;
  for (const { file, code } of ui) {
    if (total >= SOURCE_CAP) break;
    total += code.length;
    out.push(`--- ${file} ---\n${code}`);
  }
  return out.join("\n\n");
}

function artPrompt(presetKey: string | undefined, ui: Array<{ file: string; code: string }>): string {
  const p = designPreset(presetKey);
  return [
    `You are a senior product designer polishing an EXISTING, WORKING web app's VISUAL design. Improve ONLY the look and feel — layout, spacing, typography, color, component styling, visual hierarchy, and empty/loading/error states, and make it responsive. Do NOT change behavior, features, routes, data, state, validation, or dependencies.`,
    ``,
    `Target look — "${p.name}": ${p.instructions}`,
    ``,
    `Make it look like a designer set it up — consistent and polished across every screen, WCAG-AA contrast, no unstyled or default-looking pages. Output the improved files as file actions; re-emit ONLY the files you actually restyle.`,
    ``,
    `Current UI files:`,
    ``,
    uiBlock(ui),
  ].join("\n");
}

export interface ArtDirectorOptions {
  modelFactory?: ModelFactory;
  config?: EngineConfig;
}

/** The live art-director — one engine pass that restyles the UI files for the chosen preset. */
export function artDirectorRefactorer(opts: ArtDirectorOptions = {}): Refactorer {
  const modelFactory = opts.modelFactory ?? defaultModelFactory;
  const config = opts.config ?? configForStage("polish");
  return async (workspace) => {
    const ui = (await readAppSources(workspace)).filter((s) => isUi(s.file));
    if (!ui.length) return;
    const session = await new BoltEngine(liveBoltDriver({ modelFactory })).startSession(workspace, config);
    try {
      for await (const _ of session.prompt(artPrompt(process.env.VIBEHARD_DESIGN, ui))) void _;
    } finally {
      await session.dispose();
    }
  };
}
