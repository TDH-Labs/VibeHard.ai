import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeDeploy } from "./resume.ts";
import { findingRef } from "./packet.ts";
import type { Waiver } from "./review.ts";
import { SENTINEL_REL, type PipelineResult } from "../gate/index.ts";
import type { DeployTarget } from "../engine/deploy.ts";
import type { Finding, GateVerdict } from "../types.ts";

const ts = "2026-06-21T00:00:00.000Z";
const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function workspace(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "vibehard-resume-"));
  tmps.push(d);
  return d;
}
function spyTarget(): DeployTarget & { calls: number } {
  return {
    name: "spy",
    calls: 0,
    async deploy() {
      this.calls++;
      return { url: "https://spy.example/app" };
    },
  };
}
const sqli: Finding = { tool: "semgrep", ruleId: "sqli", severity: "high", file: "/src/server.js", line: 30, message: "SQLi" };
const blockResult = (): PipelineResult => ({
  verdicts: [{ gate: "sast", status: "block", findings: [sqli], blocking: 1, ranAt: ts } satisfies GateVerdict],
  passed: false,
});
const passResult = (): PipelineResult => ({
  verdicts: [{ gate: "sast", status: "pass", findings: [], blocking: 0, ranAt: ts } satisfies GateVerdict],
  passed: true,
});

describe("resumeDeploy", () => {
  test("a fix (gate now clean) → re-gates green, stamps the sentinel, deploys", async () => {
    const dir = await workspace();
    const target = spyTarget();
    const r = await resumeDeploy(dir, [], { target, gate: async () => passResult() });

    expect(r.deployed).toBe(true);
    expect(target.calls).toBe(1);
    expect(r.escalation).toBeNull();
    expect(await Bun.file(join(dir, SENTINEL_REL)).exists()).toBe(true); // ratchet stamped
  });

  test("a justified waiver downgrades the residual finding → deploys, records the waiver", async () => {
    const dir = await workspace();
    const target = spyTarget();
    const waiver: Waiver = { ref: findingRef(sqli), reviewer: "eng", justification: "parameterized elsewhere", waivedAt: ts };
    const r = await resumeDeploy(dir, [waiver], { target, gate: async () => blockResult() });

    expect(r.deployed).toBe(true);
    expect(target.calls).toBe(1);
    expect(r.waived.map(findingRef)).toEqual([findingRef(sqli)]);
  });

  test("still blocked (no waiver, still failing) → re-escalates, never deploys, clears sentinel", async () => {
    const dir = await workspace();
    // pre-seed a stale sentinel to prove the ratchet clears it on a block
    await Bun.write(join(dir, SENTINEL_REL), "stale\n");
    const target = spyTarget();
    const r = await resumeDeploy(dir, [], { target, gate: async () => blockResult(), now: ts });

    expect(r.deployed).toBe(false);
    expect(target.calls).toBe(0);
    expect(r.escalation).not.toBeNull();
    expect(r.escalation!.blocking).toBe(1);
    expect(await Bun.file(join(dir, SENTINEL_REL)).exists()).toBe(false); // stale sentinel removed
  });
});
