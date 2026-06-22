import { describe, expect, test } from "bun:test";
import { parseLogLines, scanForAnomalies, type LogEvent, type ScanOptions } from "./scan.ts";
import { routePackets } from "./report.ts";

// A Monday noon UTC → business hours, so WEBHOOK_DROP is eligible.
const NOW = "2026-06-22T12:00:00.000Z";
const nowMs = Date.parse(NOW);
const at = (minsAgo: number): string => new Date(nowMs - minsAgo * 60_000).toISOString();
const ev = (minsAgo: number, o: Partial<LogEvent>): LogEvent => ({ ts: at(minsAgo), project: "p", event: "request", ...o });
const opts = (o: Partial<ScanOptions> = {}): ScanOptions => ({ now: NOW, ...o });

const types = (events: LogEvent[], o?: Partial<ScanOptions>) => scanForAnomalies(events, opts(o)).map((p) => p.anomaly_type);

describe("LATENCY_SPIKE", () => {
  test("window p95 > 2× the 24h baseline p95 → fires; severity by SLO", () => {
    const events: LogEvent[] = [
      // baseline (before the 15m window): ~100ms on /x
      ...Array.from({ length: 20 }, (_, i) => ev(60 + i, { route: "/x", latency_ms: 100, status: 200 })),
      // window (last 15m): ~500ms on /x
      ...Array.from({ length: 10 }, (_, i) => ev(i + 1, { route: "/x", latency_ms: 500, status: 200 })),
    ];
    const packets = scanForAnomalies(events, opts({ latencySloMs: 400 }));
    const spike = packets.find((p) => p.anomaly_type === "LATENCY_SPIKE");
    expect(spike).toBeDefined();
    expect(spike!.route).toBe("/x");
    expect(spike!.severity).toBe("high"); // 500ms p95 > 400ms SLO
    expect(scanForAnomalies(events, opts({ latencySloMs: 1000 })).find((p) => p.anomaly_type === "LATENCY_SPIKE")!.severity).toBe("medium");
  });

  test("a flat, on-baseline route → no spike", () => {
    const flat = Array.from({ length: 30 }, (_, i) => ev(i + 1, { route: "/y", latency_ms: 100, status: 200 }));
    expect(types([...flat, ...Array.from({ length: 20 }, (_, i) => ev(60 + i, { route: "/y", latency_ms: 100, status: 200 }))])).not.toContain("LATENCY_SPIKE");
  });
});

describe("ERROR_CLUSTER", () => {
  test("≥3 identical errors (route + type) in window → MEDIUM", () => {
    const events = Array.from({ length: 3 }, (_, i) => ev(i + 1, { event: "error", route: "/pay", error: "TimeoutError" }));
    const p = scanForAnomalies(events, opts()).find((x) => x.anomaly_type === "ERROR_CLUSTER");
    expect(p).toMatchObject({ severity: "medium", route: "/pay" });
  });

  test("2 errors → no cluster", () => {
    expect(types(Array.from({ length: 2 }, (_, i) => ev(i + 1, { event: "error", route: "/pay", error: "TimeoutError" })))).not.toContain("ERROR_CLUSTER");
  });
});

describe("WEBHOOK_DROP", () => {
  test("a source that sent last window but 0 this window (business hours) → HIGH", () => {
    const events = [
      ev(20, { event: "webhook", source: "stripe" }), // prev window (15–30m ago)
      ev(22, { event: "webhook", source: "stripe" }),
      ev(5, { event: "request", route: "/" }), // this window has traffic, just no stripe webhook
    ];
    const p = scanForAnomalies(events, opts()).find((x) => x.anomaly_type === "WEBHOOK_DROP");
    expect(p).toMatchObject({ severity: "high", source: "stripe" });
  });

  test("still flowing this window → no drop; and off-hours is suppressed unless assumeActive", () => {
    const flowing = [ev(20, { event: "webhook", source: "stripe" }), ev(5, { event: "webhook", source: "stripe" })];
    expect(types(flowing)).not.toContain("WEBHOOK_DROP");
    // 02:00 UTC Sunday → off-hours → suppressed
    const night: ScanOptions = { now: "2026-06-21T02:00:00.000Z" };
    const droppedAtNight = [
      { ts: new Date(Date.parse(night.now) - 20 * 60000).toISOString(), project: "p", event: "webhook" as const, source: "stripe" },
    ];
    expect(scanForAnomalies(droppedAtNight, night).map((p) => p.anomaly_type)).not.toContain("WEBHOOK_DROP");
    expect(scanForAnomalies(droppedAtNight, { ...night, assumeActive: true }).map((p) => p.anomaly_type)).toContain("WEBHOOK_DROP");
  });
});

describe("ERROR_BUDGET_BURN", () => {
  test("5xx rate over budget → fires; >2× allowed → HIGH", () => {
    // 100 requests, 10 are 5xx. SLO 0.999 → allowed ≈ 0.1, floor 1 → 10 > 2×... → HIGH
    const events = [
      ...Array.from({ length: 90 }, (_, i) => ev((i % 14) + 1, { route: "/", status: 200 })),
      ...Array.from({ length: 10 }, (_, i) => ev((i % 14) + 1, { route: "/", status: 500, event: "error", error: "Boom" })),
    ];
    const p = scanForAnomalies(events, opts()).find((x) => x.anomaly_type === "ERROR_BUDGET_BURN");
    expect(p?.severity).toBe("high");
  });

  test("clean traffic → no burn", () => {
    expect(types(Array.from({ length: 50 }, (_, i) => ev((i % 14) + 1, { route: "/", status: 200 })))).not.toContain("ERROR_BUDGET_BURN");
  });
});

describe("parseLogLines + routePackets", () => {
  test("parses valid JSONL, skips malformed lines", () => {
    const body = ['{"ts":"2026-06-22T12:00:00Z","project":"p","event":"request","route":"/","status":200}', "not json", '{"event":"request"}', ""].join("\n");
    const events = parseLogLines(body);
    expect(events).toHaveLength(1); // the 2nd is malformed, the 3rd lacks ts/project
    expect(events[0]).toMatchObject({ project: "p", event: "request", route: "/" });
  });

  test("routePackets splits HIGH → build-status, MEDIUM → prod-notes", () => {
    const r = routePackets([
      { anomaly_type: "WEBHOOK_DROP", severity: "high", detected_at: NOW, window: { start: NOW, end: NOW }, measured: "", sample_log_lines: [], suggested_fix_focus: "" },
      { anomaly_type: "ERROR_CLUSTER", severity: "medium", detected_at: NOW, window: { start: NOW, end: NOW }, measured: "", sample_log_lines: [], suggested_fix_focus: "" },
    ]);
    expect(r.buildStatus).toHaveLength(1);
    expect(r.prodNotes).toHaveLength(1);
  });
});
