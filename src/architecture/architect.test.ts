import { describe, expect, test } from "bun:test";
import { architectApp, type Architect } from "./architect.ts";
import type { Architecture } from "./architecture.ts";
import type { Prd } from "../prd/index.ts";

const prd = { spec: { name: "app" }, requirements: [], nfrs: [], buyVsBuild: [] } as unknown as Prd;
const ws = (name: string, dependsOn: string[] = []) => ({ name, responsibility: name, files: [`${name}.ts`], dependsOn });
const arch = (workstreams: Architecture["workstreams"]): Architecture => ({ prd, stack: "Next.js", workstreams });

const cyclic = arch([ws("x", ["y"]), ws("y", ["x"])]);
const sound = arch([ws("api", ["db"]), ws("db")]);

describe("architectApp — grill loop (architect proposes, reviewArchitecture disposes)", () => {
  test("a sound first design → one round, ready", async () => {
    const architect: Architect = async () => sound;
    const r = await architectApp(prd, { architect });
    expect(r.ready).toBe(true);
    expect(r.rounds).toBe(1);
  });

  test("cyclic, then fixed → two rounds, ready", async () => {
    const designs = [cyclic, sound];
    let i = 0;
    const architect: Architect = async (_p, prior) => {
      expect(i === 0 ? prior === null : prior !== null).toBe(true);
      return designs[Math.min(i++, designs.length - 1)]!;
    };
    const r = await architectApp(prd, { architect });
    expect(r.rounds).toBe(2);
    expect(r.ready).toBe(true);
  });

  test("never-valid (always cyclic) → stops at budget, not ready", async () => {
    const architect: Architect = async () => cyclic;
    const r = await architectApp(prd, { architect, budget: 2 });
    expect(r.rounds).toBe(2);
    expect(r.ready).toBe(false);
    expect(r.gaps.some((g) => g.ruleId === "dependency-cycle")).toBe(true);
  });
});
