/**
 * Change requests (EPIC #52), stage 2: blast radius. Walks the traceability chain the
 * front-half already built — PRD requirement (F1…) → SRS functional requirement (FR-1…,
 * `covers` F-ids) → workstream (`covers` FR-ids) → files — to compute which parts of the app
 * a delta touches. 100% deterministic: the chain exists precisely so this question never
 * needs a model. A feature that maps to nothing is reported as unmapped (a NEW surface —
 * codegen decides where it lives), never silently dropped.
 */
import type { Prd } from "../prd/index.ts";
import type { Srs } from "../srs/index.ts";
import type { Architecture } from "../architecture/index.ts";
import type { ChangeDelta } from "./delta.ts";

export interface BlastRadius {
  /** PRD requirement ids the delta touches (modified + removed features). */
  requirementIds: string[];
  /** Workstreams whose covered requirements are touched. */
  workstreams: string[];
  /** The files those workstreams own — the regeneration scope for modifications. */
  files: string[];
  /** Touched features that map to no requirement/workstream (front-half gap or new surface). */
  unmapped: string[];
}

export function blastRadius(delta: ChangeDelta, prd: Prd, srs: Srs | null, arch: Architecture): BlastRadius {
  const touchedFeatures = [...delta.modify.map((m) => m.feature), ...delta.remove];
  const requirementIds: string[] = [];
  const unmapped: string[] = [];
  for (const feature of touchedFeatures) {
    const req = prd.requirements.find((r) => r.feature === feature);
    if (req) requirementIds.push(req.id);
    else unmapped.push(feature);
  }
  // F-ids → FR-ids (when an SRS exists; older workspaces may predate it — fall back to F-ids,
  // since some architects wrote F-ids straight into workstream.covers).
  const frIds = new Set<string>(requirementIds);
  if (srs) {
    for (const fr of srs.functionalRequirements ?? []) {
      if ((fr.covers ?? []).some((c) => requirementIds.includes(c))) frIds.add(fr.id);
    }
  }
  const workstreams: string[] = [];
  const files = new Set<string>();
  for (const ws of arch.workstreams) {
    if (!(ws.covers ?? []).some((c) => frIds.has(c))) continue;
    workstreams.push(ws.name);
    for (const f of ws.files) files.add(f);
  }
  return { requirementIds, workstreams, files: [...files].sort(), unmapped };
}
