import { describe, expect, test } from "bun:test";
import { routeFinding } from "./routing.ts";
import type { Finding } from "../types.ts";

const f = (tool: string): Finding => ({ tool, ruleId: "r", severity: "high", file: "x", message: "m" });

describe("routeFinding (deterministic specialty routing)", () => {
  test("scanners route to their specialty", () => {
    expect(routeFinding(f("semgrep"))).toBe("security");
    expect(routeFinding(f("gitleaks"))).toBe("security");
    expect(routeFinding(f("rls"))).toBe("database");
    expect(routeFinding(f("verify"))).toBe("reliability");
  });

  test("an unknown tool falls back to general (total function)", () => {
    expect(routeFinding(f("future-scanner"))).toBe("general");
  });
});
