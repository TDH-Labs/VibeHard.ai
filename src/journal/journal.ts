/**
 * The AS-BUILT JOURNAL — the build loop's working memory (and the human's audit trail).
 *
 * The planning docs (spec/PRD/SRS/architecture) say what we SET OUT to build, write-once.
 * The gate→fix loop then mutates the code, and nothing recorded what changed or why — so the
 * fixer re-tried fixes that had already failed (the oscillation we watched), the human had no
 * story behind "held for review", and a re-run re-discovered the same dead ends.
 *
 * This append-only doc closes that gap: it records, per round, what was attempted, which gate
 * failed on what, and what's being tried next. The fixer READS it ("don't repeat a fix that
 * already failed" → fewer wasted tokens); a human reads it as the build's narrative. It does
 * NOT touch the spec — intent stays immutable; this is the as-built record beside it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../types.ts";

export function journalPath(workspace: string): string {
  return join(workspace, ".vibehard", "AS_BUILT.md");
}

/** Seed the journal with the INTENDED app, once. Idempotent — a resume keeps the existing log. */
export function seedJournal(workspace: string, intent: { name?: string; summary?: string; stack?: string }): void {
  const p = journalPath(workspace);
  if (existsSync(p)) return;
  mkdirSync(join(workspace, ".vibehard"), { recursive: true });
  const lines = [
    `# As-Built Journal — ${intent.name ?? "app"}`,
    ``,
    `> Planning says what we set out to build. This records what ACTUALLY happened to pass the`,
    `> gates — attempted → which gate failed on what → what changed → what's next. The fixer reads`,
    `> it so it doesn't repeat a failed fix; a human reads it for the build's story. Intent (the`,
    `> spec) is never rewritten here.`,
    ``,
    `## Intended`,
    intent.summary ? `- ${intent.summary}` : "",
    intent.stack ? `- Stack: ${intent.stack}` : "",
    ``,
    `## Build log`,
  ].filter((l) => l !== "");
  writeFileSync(p, lines.join("\n") + "\n");
}

/** Record one gate→fix round: which gates blocked and the top localized findings. Append-only. */
export function recordRound(workspace: string, round: number, blocked: string, findings: Finding[]): void {
  const p = journalPath(workspace);
  if (!existsSync(p)) return;
  const top = findings.slice(0, 6).map((f) => `  - ${f.file}${f.line ? `:${f.line}` : ""} — ${f.message.replace(/\s+/g, " ").slice(0, 150)}`);
  appendFileSync(p, `\n### Round ${round} — blocked by ${blocked}\n${top.join("\n") || "  (no localized findings)"}\n`);
}

/** A free-form note (e.g. an architecture reconcile, an escalation, or shipped). Append-only. */
export function recordNote(workspace: string, note: string): void {
  const p = journalPath(workspace);
  if (existsSync(p)) appendFileSync(p, `\n${note}\n`);
}

/** The journal text the fixer includes as "prior attempts" context. Returns the most RECENT
 *  slice (the relevant history) under a byte cap; empty when there's no journal yet. */
export function readJournal(workspace: string, cap = 4000): string {
  const p = journalPath(workspace);
  if (!existsSync(p)) return "";
  const t = readFileSync(p, "utf8");
  return t.length > cap ? `…\n${t.slice(-cap)}` : t;
}
