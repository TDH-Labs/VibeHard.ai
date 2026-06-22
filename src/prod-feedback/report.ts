/**
 * prod-feedback routing + rendering (PROJECT_BRIEF.md §20). HIGH packets → a
 * build-status report (drives the next fix iteration); MEDIUM → prod-notes (a
 * trend log, non-blocking). `suggested_fix_focus` becomes the next iteration's first
 * focus — it NEVER auto-deploys. Pure: routing + markdown rendering; the file I/O is
 * the runner's job (index.ts).
 */
import type { ProdFeedbackPacket } from "./scan.ts";

/** Split packets by severity into the two destinations (§20). */
export function routePackets(packets: ProdFeedbackPacket[]): { buildStatus: ProdFeedbackPacket[]; prodNotes: ProdFeedbackPacket[] } {
  return {
    buildStatus: packets.filter((p) => p.severity === "high"),
    prodNotes: packets.filter((p) => p.severity === "medium"),
  };
}

/** Render a set of packets as a markdown report. Pure. */
export function renderReport(title: string, packets: ProdFeedbackPacket[], now: string): string {
  const lines = [`# ${title}`, "", `_scan at ${now}_`, ""];
  if (packets.length === 0) {
    lines.push("No anomalies this scan.");
    return lines.join("\n") + "\n";
  }
  for (const p of packets) {
    const subject = p.route ? ` — ${p.route}` : p.source ? ` — ${p.source}` : "";
    lines.push(`## ${p.anomaly_type} (${p.severity})${subject}`);
    lines.push(`- detected: ${p.detected_at} · window ${p.window.start} → ${p.window.end}`);
    lines.push(`- measured: ${p.measured}`);
    lines.push(`- fix focus: ${p.suggested_fix_focus}`);
    if (p.sample_log_lines.length) {
      lines.push(`- samples:`);
      for (const s of p.sample_log_lines) lines.push(`  - \`${s}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}
