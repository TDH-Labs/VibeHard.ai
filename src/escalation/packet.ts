/**
 * Escalation packet (PROJECT_BRIEF.md §3, §7, §11). When the gate blocks a deploy,
 * each blocking finding is localized to a SMALL code slice and routed to a
 * specialty. This pre-localization is the unit-economics unlock (§7): it turns
 * "review this app" into "review these 6 lines" — which is what makes on-demand
 * human review cheap enough to be a business.
 *
 * Deterministic: the only non-purity is reading the flagged files to cut the
 * slice. Findings flow gate → packet → (later) review UI as one typed shape (§4).
 */
import { isAbsolute, join } from "node:path";
import type { Finding, GateVerdict } from "../types.ts";
import { isBlocking } from "../types.ts";
import { routeFinding, type Specialty } from "./routing.ts";

/** Lines of source around a finding — the localized slice a reviewer reads. */
export interface CodeSlice {
  file: string; // workspace-relative
  startLine: number;
  endLine: number;
  code: string;
}

export interface EscalationItem {
  ref: string; // stable id; matches a ReviewDecision/Waiver back to this finding
  finding: Finding;
  specialty: Specialty;
  slice: CodeSlice | null; // null when the finding has no line or the file is unreadable
}

export interface EscalationPacket {
  workspacePath: string;
  createdAt: string; // ISO; injected for determinism
  reason: string;
  items: EscalationItem[];
  specialties: Specialty[]; // distinct specialties this packet needs, for routing
  blocking: number;
}

/** Lines of context to include on each side of the flagged line. */
const CONTEXT = 3;

/** Stable identifier for a finding — used to match human decisions back to it. */
export function findingRef(f: Finding): string {
  return `${f.file}:${f.line ?? "?"}:${f.ruleId}`;
}

/** Map a finding's reported path to a workspace-relative one. The SAST/secrets
 *  gates run in a container mounted at /src, so their paths are `/src/<rel>`. */
function toWorkspaceRelative(file: string): string {
  if (file.startsWith("/src/")) return file.slice("/src/".length);
  return file;
}

async function extractSlice(workspacePath: string, finding: Finding): Promise<CodeSlice | null> {
  if (!finding.line || finding.line < 1) return null; // nothing to localize
  const rel = toWorkspaceRelative(finding.file);
  const abs = isAbsolute(rel) ? rel : join(workspacePath, rel);
  const file = Bun.file(abs);
  if (!(await file.exists())) return null;

  const lines = (await file.text()).split("\n");
  const start = Math.max(1, finding.line - CONTEXT);
  const end = Math.min(lines.length, finding.line + CONTEXT);
  return { file: rel, startLine: start, endLine: end, code: lines.slice(start - 1, end).join("\n") };
}

/**
 * Build an escalation packet from a (blocked) set of verdicts: localize every
 * blocking finding and route it. Non-blocking findings (medium/low) are not
 * escalated — block-by-default keeps the human queue to what actually stops a ship.
 */
export async function buildEscalationPacket(
  verdicts: GateVerdict[],
  workspacePath: string,
  opts: { reason?: string; now?: string } = {},
): Promise<EscalationPacket> {
  const now = opts.now ?? new Date().toISOString();
  const blocking = verdicts.flatMap((v) => v.findings).filter(isBlocking);

  const items: EscalationItem[] = [];
  for (const finding of blocking) {
    items.push({
      ref: findingRef(finding),
      finding,
      specialty: routeFinding(finding),
      slice: await extractSlice(workspacePath, finding),
    });
  }

  return {
    workspacePath,
    createdAt: now,
    reason: opts.reason ?? "deploy blocked by the gate chain",
    items,
    specialties: [...new Set(items.map((i) => i.specialty))],
    blocking: items.length,
  };
}
