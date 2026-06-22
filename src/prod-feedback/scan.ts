/**
 * prod-feedback scan (PROJECT_BRIEF.md §20) — the production back-edge that closes
 * the lifecycle: a deployed app emits structured JSONL logs → this deterministic
 * scan detects anomalies → a typed feedback packet feeds the next iteration.
 *
 * NON-BLOCKING, FEEDS-FORWARD (§11: never an LLM in a blocking path). This is NOT a
 * deploy gate — it's a scheduled scan (cadence is a scheduler's job; we build the
 * scan). The scan is PURE over a set of log events; the actual log emission + the
 * schedule + hosting are §15-LATER, but the contract (schema, detectors, packet) is
 * fixed now. Webhook health is modelled IN-SCHEMA (a v0 bug keyed off an
 * undocumented field, so a compliant app never tripped WEBHOOK_DROP).
 */

export type LogEventType = "request" | "webhook" | "error";

/** One append-only log line the app emits (PII sanitized before logging — §21). */
export interface LogEvent {
  ts: string; // ISO
  project: string;
  event: LogEventType;
  route?: string;
  source?: string; // e.g. "stripe" for a webhook
  latency_ms?: number;
  status?: number;
  error?: string | null;
}

export type AnomalyType = "LATENCY_SPIKE" | "ERROR_CLUSTER" | "WEBHOOK_DROP" | "ERROR_BUDGET_BURN";

export interface ProdFeedbackPacket {
  anomaly_type: AnomalyType;
  severity: "high" | "medium";
  detected_at: string;
  window: { start: string; end: string };
  route?: string;
  source?: string;
  measured: string; // human-readable: measured vs baseline vs SLO
  sample_log_lines: string[]; // up to 3
  suggested_fix_focus: string; // the next iteration's first focus — NEVER auto-deployed
}

export interface ScanOptions {
  now: string; // scan time (ISO) — injected for determinism
  windowMs?: number; // anomaly window (default 15m)
  baselineMs?: number; // rolling latency baseline (default 24h)
  slo?: number; // availability SLO 0..1 (default 0.999)
  latencySloMs?: number; // route latency SLO for severity (default 1000ms)
  /** bypass the business-hours gate on WEBHOOK_DROP (default false → gated). */
  assumeActive?: boolean;
}

const WINDOW_MS = 15 * 60 * 1000;
const BASELINE_MS = 24 * 60 * 60 * 1000;

// ── small pure helpers ───────────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}
const p95 = (v: number[]): number => percentile(v, 95);
const median = (v: number[]): number => percentile(v, 50);

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    (m.get(k) ?? m.set(k, []).get(k)!).push(it);
  }
  return m;
}

const within = (events: LogEvent[], startMs: number, endMs: number): LogEvent[] =>
  events.filter((e) => {
    const t = Date.parse(e.ts);
    return !Number.isNaN(t) && t > startMs && t <= endMs;
  });

const is5xx = (e: LogEvent): boolean => (e.status ?? 0) >= 500 || e.event === "error";

/** Mon–Fri, 08:00–20:00 UTC — a coarse "active" window so a quiet night doesn't
 *  look like a dropped webhook. (Timezone nuance is a refinement.) */
function isBusinessHours(iso: string): boolean {
  const d = new Date(iso);
  const day = d.getUTCDay(); // 0 Sun .. 6 Sat
  const hour = d.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 8 && hour < 20;
}

const sample = (events: LogEvent[]): string[] => events.slice(0, 3).map((e) => JSON.stringify(e));

// ── the four detectors (pure) ─────────────────────────────────────────────────

/** LATENCY_SPIKE — route p95 > 2× rolling-baseline p95, OR a single request > 5×
 *  the route median. HIGH if window p95 > the latency SLO, else MEDIUM. */
export function detectLatencySpike(windowEvents: LogEvent[], baseline: LogEvent[], latencySloMs: number, win: { start: string; end: string }, now: string): ProdFeedbackPacket[] {
  const out: ProdFeedbackPacket[] = [];
  const timed = windowEvents.filter((e) => typeof e.latency_ms === "number");
  for (const [route, evs] of groupBy(timed, (e) => e.route ?? "?")) {
    const lat = evs.map((e) => e.latency_ms!);
    const baseLat = baseline.filter((e) => (e.route ?? "?") === route && typeof e.latency_ms === "number").map((e) => e.latency_ms!);
    const winP95 = p95(lat);
    const baseP95 = p95(baseLat);
    const med = median(baseLat.length ? baseLat : lat);
    const maxSingle = Math.max(...lat);
    const spikeVsBaseline = baseP95 > 0 && winP95 > 2 * baseP95;
    const spikeSingle = med > 0 && maxSingle > 5 * med;
    if (!spikeVsBaseline && !spikeSingle) continue;
    out.push({
      anomaly_type: "LATENCY_SPIKE",
      severity: winP95 > latencySloMs ? "high" : "medium",
      detected_at: now,
      window: win,
      route,
      measured: `p95 ${winP95}ms vs 24h-baseline ${baseP95}ms (SLO ${latencySloMs}ms); slowest ${maxSingle}ms vs median ${med}ms`,
      sample_log_lines: sample([...evs].sort((a, b) => (b.latency_ms ?? 0) - (a.latency_ms ?? 0))),
      suggested_fix_focus: `Investigate the slow path on ${route} — recent change to that handler, a missing index, or an unbounded query/external call.`,
    });
  }
  return out;
}

/** ERROR_CLUSTER — ≥3 identical errors (same route + error type) in the window → MEDIUM. */
export function detectErrorCluster(windowEvents: LogEvent[], win: { start: string; end: string }, now: string): ProdFeedbackPacket[] {
  const errs = windowEvents.filter((e) => e.event === "error" || (e.error != null && e.error !== ""));
  const out: ProdFeedbackPacket[] = [];
  for (const [key, evs] of groupBy(errs, (e) => `${e.route ?? "?"}|${e.error ?? "?"}`)) {
    if (evs.length < 3) continue;
    const [route, errType] = key.split("|");
    out.push({
      anomaly_type: "ERROR_CLUSTER",
      severity: "medium",
      detected_at: now,
      window: win,
      route,
      measured: `${evs.length} identical errors "${errType}" on ${route} in window`,
      sample_log_lines: sample(evs),
      suggested_fix_focus: `Fix the recurring "${errType}" on ${route}.`,
    });
  }
  return out;
}

/** WEBHOOK_DROP — a source that sent ≥1 webhook last window sent 0 this window
 *  (during business hours) → HIGH (silent data loss). */
export function detectWebhookDrop(thisWindow: LogEvent[], prevWindow: LogEvent[], win: { start: string; end: string }, now: string, assumeActive: boolean): ProdFeedbackPacket[] {
  if (!assumeActive && !isBusinessHours(now)) return [];
  const sourcesThis = new Set(thisWindow.filter((e) => e.event === "webhook" && e.source).map((e) => e.source!));
  const prevBySource = groupBy(prevWindow.filter((e) => e.event === "webhook" && e.source), (e) => e.source!);
  const out: ProdFeedbackPacket[] = [];
  for (const [source, prevEvs] of prevBySource) {
    if (sourcesThis.has(source)) continue; // still flowing
    out.push({
      anomaly_type: "WEBHOOK_DROP",
      severity: "high",
      detected_at: now,
      window: win,
      source,
      measured: `${source} sent ${prevEvs.length} webhook(s) last window, 0 this window — possible silent data loss`,
      sample_log_lines: sample(prevEvs),
      suggested_fix_focus: `Check the ${source} webhook integration — endpoint reachability, signature/secret, and that ${source} is still sending.`,
    });
  }
  return out;
}

/** ERROR_BUDGET_BURN — window 5xx rate over the SLO budget. allowed = total×(1−SLO),
 *  floor 1; breach when failures > allowed; HIGH when failures > 2× allowed. */
export function detectErrorBudgetBurn(windowEvents: LogEvent[], slo: number, win: { start: string; end: string }, now: string): ProdFeedbackPacket[] {
  const servable = windowEvents.filter((e) => e.event === "request" || e.event === "error" || typeof e.status === "number");
  const total = servable.length;
  if (total === 0) return [];
  const failures = servable.filter(is5xx).length;
  const allowed = Math.max(1, total * (1 - slo));
  if (failures <= allowed) return [];
  return [
    {
      anomaly_type: "ERROR_BUDGET_BURN",
      severity: failures > 2 * allowed ? "high" : "medium",
      detected_at: now,
      window: win,
      measured: `${failures}/${total} failed (${((failures / total) * 100).toFixed(1)}%) — over the ${((1 - slo) * 100).toFixed(2)}% budget (allowed ≈ ${allowed.toFixed(1)})`,
      sample_log_lines: sample(servable.filter(is5xx)),
      suggested_fix_focus: `Reduce 5xx errors — the window error rate exceeds the SLO budget; investigate the failing routes first.`,
    },
  ];
}

/** Run all detectors over the events for a scan at `now`. Pure. */
export function scanForAnomalies(events: LogEvent[], opts: ScanOptions): ProdFeedbackPacket[] {
  const now = Date.parse(opts.now);
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const baselineMs = opts.baselineMs ?? BASELINE_MS;
  const slo = opts.slo ?? 0.999;
  const latencySloMs = opts.latencySloMs ?? 1000;

  const win = { start: new Date(now - windowMs).toISOString(), end: opts.now };
  const thisWindow = within(events, now - windowMs, now);
  const prevWindow = within(events, now - 2 * windowMs, now - windowMs);
  // baseline EXCLUDES the current window, so a spike in it stands out against the norm.
  const baseline = within(events, now - baselineMs, now - windowMs);

  return [
    ...detectLatencySpike(thisWindow, baseline, latencySloMs, win, opts.now),
    ...detectErrorCluster(thisWindow, win, opts.now),
    ...detectWebhookDrop(thisWindow, prevWindow, win, opts.now, opts.assumeActive ?? false),
    ...detectErrorBudgetBurn(thisWindow, slo, win, opts.now),
  ];
}

/** Parse a JSONL log body into typed events, skipping malformed lines (trust boundary). */
export function parseLogLines(body: string): LogEvent[] {
  const out: LogEvent[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      if (typeof o.ts === "string" && typeof o.project === "string" && (o.event === "request" || o.event === "webhook" || o.event === "error")) {
        out.push({
          ts: o.ts,
          project: o.project,
          event: o.event,
          route: typeof o.route === "string" ? o.route : undefined,
          source: typeof o.source === "string" ? o.source : undefined,
          latency_ms: typeof o.latency_ms === "number" ? o.latency_ms : undefined,
          status: typeof o.status === "number" ? o.status : undefined,
          error: typeof o.error === "string" ? o.error : null,
        });
      }
    } catch {
      /* skip a malformed line */
    }
  }
  return out;
}
