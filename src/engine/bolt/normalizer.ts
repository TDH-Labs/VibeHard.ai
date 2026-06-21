/**
 * bolt.diy → Drydock event normalizer (PROJECT_BRIEF.md §13 fault line #1, §14).
 *
 * RECONCILED 2026-06-21 against the real bolt.diy source
 * (stackblitz-labs/bolt.diy → app/lib/runtime/message-parser.ts + the emission
 * contract in app/lib/common/prompts/prompts.ts). What the real source confirms:
 *
 *   • Artifacts: `<boltArtifact id title> … </boltArtifact>`, and a message may
 *     contain MORE THAN ONE — the real parser is stateful and multi-artifact. We
 *     parse them ALL, in order, preserving prose between them. (Was: first artifact
 *     only, which silently dropped every file after the first — §14 Gap 2.)
 *
 *   • Actions: `type` ∈ {file, shell, start, supabase}. Files carry `filePath`
 *     (parser:369/375, FileAction.filePath, prompt:350) — NOT `path`. The `path`
 *     at message-parser.ts:119 belongs to the `<bolt-quick-actions>` button
 *     feature, a different construct that carries no files. So `filePath` is the
 *     correct (and only) file attribute; no `path` fallback is warranted.
 *
 *   • Supabase (prompt:115-141): a DB change is emitted as
 *     `<boltAction type="supabase" operation="migration" filePath="/supabase/migrations/x.sql">`
 *     carrying the SQL. That file IS the RLS gate's only input. Routing it to a
 *     shell command (the old default for non-file actions) would never materialize
 *     it → the RLS gate would see no migrations and pass blind — defeating the
 *     exact CVE-2025-48757 class Drydock exists to catch. We materialize it as a
 *     file. The paired `operation="query"` re-runs the same SQL (no file) and is
 *     surfaced as a command.
 *
 * Streaming (§14 Gap 1): bolt parses incrementally (onActionOpen/Stream/Close);
 * we deliberately keep ACCUMULATE-THEN-PARSE (rationale + progress indicator in
 * engine.ts). This file stays a pure function over the full message; the
 * incremental path is a contained, behind-the-seam change for when the UI exists.
 *
 * Pure (no I/O): fully unit-tested. engine.ts performs file materialization.
 *
 * DEFERRED fidelity items (faithful to bolt, not yet ported — none drop files):
 * markdown-fence stripping + escaped-tag unescaping + trailing newline on file
 * content (message-parser.ts:60-75,151-159); `<bolt-quick-actions>` button blocks
 * (currently pass through as prose).
 */
import type { EngineEvent } from "../../types.ts";

/** One ordered piece of a bolt assistant message: prose or a typed action. */
export type BoltSegment =
  | { kind: "text"; text: string }
  | { kind: "file"; filePath: string; content: string }
  | { kind: "shell"; command: string }
  | { kind: "start"; command: string };

const ARTIFACT_OPEN = "<boltArtifact";
const ARTIFACT_CLOSE = "</boltArtifact>";
// Global so matchAll is safe (matchAll uses an internal clone — original lastIndex
// is untouched), and it never crosses an artifact boundary (fed only `inner`).
const ACTION_RE = /<boltAction\b([^>]*)>([\s\S]*?)<\/boltAction>/g;

/** Case-insensitive single-attribute read, matching bolt's #extractAttribute. */
function attr(rawAttrs: string, name: string): string | undefined {
  return new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(rawAttrs)?.[1];
}

function pushText(out: BoltSegment[], text: string): void {
  if (text.length > 0) out.push({ kind: "text", text });
}

/** Extract every complete `<boltAction>` in one artifact's inner content, in order. */
function pushActions(out: BoltSegment[], inner: string): void {
  for (const m of inner.matchAll(ACTION_RE)) {
    const attrs = m[1] ?? "";
    const content = m[2] ?? "";
    const type = attr(attrs, "type");
    const filePath = attr(attrs, "filePath");

    if (type === "file") {
      out.push({ kind: "file", filePath: filePath ?? "", content });
    } else if (type === "supabase") {
      // A migration carries the SQL file the RLS gate scans; a query re-runs the
      // same SQL with no file. Only the migration materializes.
      if (attr(attrs, "operation") === "migration" && filePath) {
        out.push({ kind: "file", filePath, content });
      } else {
        out.push({ kind: "shell", command: content.trim() });
      }
    } else if (type === "start") {
      out.push({ kind: "start", command: content.trim() });
    } else {
      // shell + any unknown/build type → a command. Never a silently-dropped file.
      out.push({ kind: "shell", command: content.trim() });
    }
  }
}

/**
 * Tolerant parse of a full (or partial) bolt message → ordered segments across
 * ALL artifacts, with prose preserved before/between/after them. Never throws:
 * a partial trailing artifact contributes its complete actions, then parsing stops.
 */
export function parseBoltStream(raw: string): BoltSegment[] {
  const segments: BoltSegment[] = [];
  let cursor = 0;

  while (true) {
    const openStart = raw.indexOf(ARTIFACT_OPEN, cursor);
    if (openStart === -1) break;
    const openEnd = raw.indexOf(">", openStart);
    if (openEnd === -1) break; // partial open tag — emit the rest as prose below

    pushText(segments, raw.slice(cursor, openStart)); // prose before this artifact

    const innerStart = openEnd + 1;
    const closeIdx = raw.indexOf(ARTIFACT_CLOSE, innerStart);
    const inner = closeIdx === -1 ? raw.slice(innerStart) : raw.slice(innerStart, closeIdx);
    pushActions(segments, inner);

    if (closeIdx === -1) return segments; // unterminated final artifact (partial stream)
    cursor = closeIdx + ARTIFACT_CLOSE.length;
  }

  pushText(segments, raw.slice(cursor)); // trailing prose
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
