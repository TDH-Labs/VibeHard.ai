/**
 * prod-feedback (PROJECT_BRIEF.md §20) — the production back-edge. A deterministic,
 * NON-BLOCKING scan over a deployed app's JSONL logs → typed feedback packets that
 * feed the next iteration (HIGH → build-status, MEDIUM → prod-notes). The scheduler
 * (cadence 5m) and the hosting that emits the logs are §15-LATER; the scan + the
 * contract are here.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseLogLines, scanForAnomalies, type ProdFeedbackPacket, type ScanOptions } from "./scan.ts";
import { renderReport, routePackets } from "./report.ts";

export {
  parseLogLines,
  scanForAnomalies,
  detectLatencySpike,
  detectErrorCluster,
  detectWebhookDrop,
  detectErrorBudgetBurn,
  type LogEvent,
  type LogEventType,
  type AnomalyType,
  type ProdFeedbackPacket,
  type ScanOptions,
} from "./scan.ts";
export { routePackets, renderReport } from "./report.ts";

export interface ProdScanResult {
  packets: ProdFeedbackPacket[];
  high: number;
  medium: number;
  buildStatusPath: string;
  prodNotesPath: string;
}

/** Read a JSONL log file, scan it, and write build-status.md (HIGH) + prod-notes.md
 *  (MEDIUM) next to it. Returns the packets + where they were written. Non-blocking
 *  — this is the back-edge, never a deploy gate. */
export function runProdScan(logPath: string, opts: ScanOptions): ProdScanResult {
  const body = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const events = parseLogLines(body);
  const packets = scanForAnomalies(events, opts);
  const { buildStatus, prodNotes } = routePackets(packets);

  const dir = dirname(logPath);
  const buildStatusPath = join(dir, "build-status.md");
  const prodNotesPath = join(dir, "prod-notes.md");
  writeFileSync(buildStatusPath, renderReport("Production status — needs attention", buildStatus, opts.now));
  writeFileSync(prodNotesPath, renderReport("Production notes — trends", prodNotes, opts.now));

  return { packets, high: buildStatus.length, medium: prodNotes.length, buildStatusPath, prodNotesPath };
}
