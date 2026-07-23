/**
 * The gate-verdict printer — shared by `vibehard gate`/`vibehard deploy` (VibeHard's CLI) and this
 * package's own standalone `gate-check` CLI (`bin/gate-check.ts`), so there is exactly one
 * implementation of "print a pipeline result" instead of two that drift.
 *
 * `formatFinding` is an injection seam (same DI pattern as verify.ts's sandbox / completeness.ts's
 * reviewer): the default is a plain, technical one-liner. A host application with its own
 * plain-English translation layer (e.g. VibeHard's `translateFinding`, which reads from a curated,
 * product-specific dictionary — not portable, not this package's concern) injects its own formatter
 * to keep its existing richer CLI output unchanged.
 */
import type { Finding, GateVerdict } from "./types.ts";

/** Structurally matches both `PipelineResult` and `DeployResult` (`index.ts`) — duck-typed here,
 *  not imported, to avoid a circular import (index.ts already imports this module). */
export interface ReportResult {
  verdicts: GateVerdict[];
  passed: boolean;
  /** present only on a DeployResult; printed when present. */
  sentinel?: string | null;
}

const SEV_DOT: Record<Finding["severity"], string> = { critical: "🔴", high: "🔴", medium: "🟠", low: "🟡" };

function defaultFormatFinding(f: Finding, indent: string): void {
  console.log(`${indent}${SEV_DOT[f.severity]} ${f.tool}:${f.ruleId} @ ${f.file}:${f.line ?? "?"}`);
  console.log(`${indent}   ${f.message}`);
}

export interface PrintReportOptions {
  /** Format one finding for display; default prints tool:ruleId@file:line + the raw message. */
  formatFinding?: (f: Finding, indent: string) => void;
}

/** Printed once per run, right before the final verdict — not per-gate, so it reads as a caveat
 *  on the OVERALL result rather than noise on every individual line. Added 2026-07-23: an
 *  out-of-distribution run of `vibehard gate <dir>` against an unrelated codebase treated a
 *  shrinking blocking-finding count as evidence a real authorization vulnerability had gotten
 *  safer — it hadn't. Checked out the pre-fix and post-fix commits of a real unauthenticated
 *  critical and ran the full chain against both: IDENTICAL verdicts, zero findings touching the
 *  authorization model either time. These gates are pattern/inventory scanners; they were never
 *  designed to reason about what a codebase's logic actually does. */
const SCOPE_NOTE =
  "\nScope: these are pattern/inventory checks — known CVEs, leaked secrets, missing hardening\n" +
  "directives, and known-bad SQL/RLS shapes. They do NOT reason about your application's\n" +
  "business logic or authorization model — a clean pass is not a security review of what the\n" +
  "code actually does, and a shrinking finding count is not proof a vulnerability got fixed.";

/** Print every gate's verdict, then the overall PASS/BLOCK line (+ sentinel status when the
 *  result carries one — i.e. a DeployResult). Pure side-effect (console.log); does not exit. */
export function printReport(result: ReportResult, opts: PrintReportOptions = {}): void {
  const formatFinding = opts.formatFinding ?? defaultFormatFinding;
  for (const v of result.verdicts) {
    console.log(`\n── ${v.gate} → ${v.status.toUpperCase()} (${v.blocking} blocking) ──`);
    for (const f of v.findings) formatFinding(f, "  ");
  }
  console.log(SCOPE_NOTE);
  if (result.passed) {
    console.log("\n✅ PASS — deploy allowed");
    if ("sentinel" in result) console.log(`   sentinel written: ${result.sentinel}`);
  } else {
    console.log("\n🛑 BLOCK — deploy refused");
    if ("sentinel" in result) console.log("   no sentinel written");
  }
}
