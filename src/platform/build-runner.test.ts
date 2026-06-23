import { describe, expect, test } from "bun:test";
import { LocalBuildRunner } from "./build-runner.ts";
import type { BuildJob } from "./build.ts";
import type { AutoFixResult } from "../autofix/index.ts";
import type { EscalationPacket, EscalationSink, EscalationTicket } from "../escalation/index.ts";

const job = (workspacePath?: string): BuildJob => ({ id: "j1", tenantId: "t1", app: "a", status: "running", queuedAt: "t", ...(workspacePath ? { workspacePath } : {}) });
const fixResult = (over: Partial<AutoFixResult>): AutoFixResult => ({ fixed: false, attempts: 1, finalVerdicts: [], escalation: null, log: [], ...over });

describe("LocalBuildRunner", () => {
  test("no workspacePath → fails fast (nothing to build)", async () => {
    const runner = new LocalBuildRunner({ autoFix: async () => fixResult({ fixed: true }) });
    const r = await runner.run(job());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no workspacePath/);
  });

  test("gate green (autoFix fixed) → ok; the real engine ran on the job's workspace", async () => {
    let calledWith = "";
    const autoFix = async (ws: string): Promise<AutoFixResult> => {
      calledWith = ws;
      return fixResult({ fixed: true, attempts: 2 });
    };
    const r = await new LocalBuildRunner({ autoFix }).run(job("/ws/app"));
    expect(r.ok).toBe(true);
    expect(calledWith).toBe("/ws/app");
  });

  test("held build → escalates through the sink (the moat) and reports the ticket", async () => {
    const opened: EscalationPacket[] = [];
    const sink = {
      name: "fake",
      open: async (p: EscalationPacket) => {
        opened.push(p);
        return { id: "esc-42" } as EscalationTicket;
      },
    } as unknown as EscalationSink;
    const autoFix = async (): Promise<AutoFixResult> => fixResult({ fixed: false, attempts: 10, escalation: { blocking: 2 } as unknown as EscalationPacket });
    const r = await new LocalBuildRunner({ autoFix, sink }).run(job("/ws/app"));
    expect(r.ok).toBe(false);
    expect(opened.length).toBe(1); // the held escalation was routed to the sink
    expect(r.error).toMatch(/escalated → esc-42/);
  });

  test("held build with no sink wired → fails without escalating", async () => {
    const autoFix = async (): Promise<AutoFixResult> => fixResult({ fixed: false, attempts: 10, escalation: { blocking: 1 } as unknown as EscalationPacket });
    const r = await new LocalBuildRunner({ autoFix }).run(job("/ws/app"));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/gate blocked after 10/);
  });
});
