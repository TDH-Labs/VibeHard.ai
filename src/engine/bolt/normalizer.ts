/**
 * bolt.diy → Drydock event normalizer (PROJECT_BRIEF.md §13, fault line #1).
 *
 * The UI/orchestrator must only ever see OUR normalized `EngineEvent` stream —
 * never an engine's native protocol — so swapping engines stays invisible to the
 * user. This module is that boundary for bolt.diy: it parses bolt's native
 * artifact/action wire format and maps it onto our event union.
 *
 * Pure (no I/O): fully unit-tested. The engine adapter (engine.ts) does the file
 * materialization side effects; this only interprets the protocol.
 *
 * ⚠️ WIRE-FORMAT ASSUMPTION — verify against the real fork. bolt.diy streams an
 * assistant message that interleaves prose with ONE <boltArtifact> block holding
 * <boltAction> elements:
 *   <boltArtifact id="..." title="...">
 *     <boltAction type="file" filePath="src/app.ts">…content…</boltAction>
 *     <boltAction type="shell">npm install</boltAction>
 *     <boltAction type="start">npm run dev</boltAction>
 *   </boltArtifact>
 * The exact tag/attr spelling is the only thing this file assumes about bolt; it
 * is isolated here on purpose so confirming it against the fork is a one-file diff.
 */
import type { EngineEvent } from "../../types.ts";

/** One ordered piece of a bolt assistant message: prose or a typed action. */
export type BoltSegment =
  | { kind: "text"; text: string }
  | { kind: "file"; filePath: string; content: string }
  | { kind: "shell"; command: string }
  | { kind: "start"; command: string };

const ARTIFACT_RE = /<boltArtifact\b[^>]*>([\s\S]*?)<\/boltArtifact>/;
const ACTION_RE = /<boltAction\b([^>]*)>([\s\S]*?)<\/boltAction>/g;

function attr(rawAttrs: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(rawAttrs);
  return m?.[1];
}

/** Tolerant parse of a (possibly partial) bolt assistant message → ordered segments.
 *  Never throws: anything it can't recognize is preserved as text. */
export function parseBoltStream(raw: string): BoltSegment[] {
  const segments: BoltSegment[] = [];
  const artifact = ARTIFACT_RE.exec(raw);

  if (!artifact) {
    if (raw.length > 0) segments.push({ kind: "text", text: raw });
    return segments;
  }

  const before = raw.slice(0, artifact.index);
  if (before.length > 0) segments.push({ kind: "text", text: before });

  const inner = artifact[1] ?? "";
  for (const m of inner.matchAll(ACTION_RE)) {
    const attrs = m[1] ?? "";
    const content = m[2] ?? "";
    const type = attr(attrs, "type");
    if (type === "file") {
      segments.push({ kind: "file", filePath: attr(attrs, "filePath") ?? "", content });
    } else if (type === "start") {
      segments.push({ kind: "start", command: content.trim() });
    } else {
      // default (incl. type="shell") → a shell command
      segments.push({ kind: "shell", command: content.trim() });
    }
  }

  const after = raw.slice(artifact.index + artifact[0].length);
  if (after.length > 0) segments.push({ kind: "text", text: after });
  return segments;
}

/**
 * Map a single segment to an `EngineEvent`. `seen` tracks already-written paths so
 * a repeated file write normalizes to `edit` rather than `create`. Returns null
 * for empty prose (nothing worth surfacing). Caller mutates `seen` after writing.
 */
export function segmentToEvent(seg: BoltSegment, seen: ReadonlySet<string>): EngineEvent | null {
  switch (seg.kind) {
    case "text": {
      const text = seg.text.trim();
      return text.length > 0 ? { type: "message", text } : null;
    }
    case "file":
      return { type: "file-changed", path: seg.filePath, action: seen.has(seg.filePath) ? "edit" : "create" };
    case "shell":
    case "start":
      return { type: "message", text: `$ ${seg.command}` };
  }
}

/** Convenience: a full bolt message → the complete normalized event list, ending
 *  in `done`. Pure — used to unit-test the parse+map pipeline end to end. */
export function normalizeBoltStream(raw: string): EngineEvent[] {
  const seen = new Set<string>();
  const events: EngineEvent[] = [];
  for (const seg of parseBoltStream(raw)) {
    const ev = segmentToEvent(seg, seen);
    if (seg.kind === "file") seen.add(seg.filePath);
    if (ev) events.push(ev);
  }
  events.push({ type: "done" });
  return events;
}
