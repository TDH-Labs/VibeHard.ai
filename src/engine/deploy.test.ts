import { describe, expect, test } from "bun:test";
import { gatedDeploy, noopDeployTarget, type DeployTarget } from "./deploy.ts";
import type { DeployResult } from "../gate/index.ts";

const ts = "2026-06-20T00:00:00.000Z";

const PASS: DeployResult = {
  passed: true,
  sentinel: "/ws/.gate/HARD_VERIFY_PASS",
  verdicts: [{ gate: "sast", status: "pass", findings: [], blocking: 0, ranAt: ts }],
};

const BLOCK: DeployResult = {
  passed: false,
  sentinel: null,
  verdicts: [
    { gate: "sast", status: "block", findings: [], blocking: 2, ranAt: ts },
    { gate: "rls", status: "block", findings: [], blocking: 1, ranAt: ts },
  ],
};

/** A target that records whether it was reached. */
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

describe("gatedDeploy — the gate sits between generate and deploy", () => {
  test("a blocked verdict NEVER reaches the deploy target", async () => {
    const target = spyTarget();
    const r = await gatedDeploy("/ws", target, async () => BLOCK);
    expect(target.calls).toBe(0);
    expect(r.deployed).toBe(false);
    expect(r.url).toBeNull();
    expect(r.reason).toContain("sast");
    expect(r.reason).toContain("rls");
  });

  test("a passing verdict deploys exactly once and returns the URL", async () => {
    const target = spyTarget();
    const r = await gatedDeploy("/ws", target, async () => PASS);
    expect(target.calls).toBe(1);
    expect(r.deployed).toBe(true);
    expect(r.url).toBe("https://spy.example/app");
    expect(r.verdict.sentinel).toBe("/ws/.gate/HARD_VERIFY_PASS");
  });

  test("the noop target throws if a passing build reaches it (no connector yet)", async () => {
    await expect(gatedDeploy("/ws", noopDeployTarget, async () => PASS)).rejects.toThrow(/no deploy target/);
  });

  test("noop is never invoked on a block — refusal short-circuits before deploy", async () => {
    const r = await gatedDeploy("/ws", noopDeployTarget, async () => BLOCK);
    expect(r.deployed).toBe(false);
  });
});
