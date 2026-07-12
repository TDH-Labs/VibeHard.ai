import { describe, expect, test } from "bun:test";
import { architectApp, type Architect } from "./architect.ts";
import type { Architecture } from "./architecture.ts";
import type { Prd } from "../prd/index.ts";

const prd = { spec: { name: "app" }, requirements: [], nfrs: [], buyVsBuild: [] } as unknown as Prd;
const ws = (name: string, dependsOn: string[] = []) => ({ name, responsibility: name, files: [`${name}.ts`], dependsOn, covers: [] });
const arch = (workstreams: Architecture["workstreams"]): Architecture => ({
  prd,
  stack: "Next.js",
  workstreams,
  systemOverview: "an app",
  architecturalGoals: [],
  pattern: { name: "modular monolith", rationale: "small team + substrate fit", tradeoffs: "less ultimate scalability" },
  dataFlow: "REST",
  dataArchitecture: { storageRationale: "", schema: "", stateManagement: "" },
});

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

  // The one integration question the pure assessSubstrateFit unit tests (architecture.test.ts)
  // don't answer on their own: does a BAD first proposal actually get looped back and fixed
  // through architectApp's real retry mechanism — same question the "cyclic, then fixed" case
  // above already proves for graph gaps, now for this codebase's newest substrate-fit rule.
  describe("clientOnlyStorage — the retry loop actually self-corrects (2026-07-12)", () => {
    const clientOnlyPrd = { spec: { name: "app", storesData: true, clientOnlyStorage: true }, requirements: [], nfrs: [], buyVsBuild: [] } as unknown as Prd;
    const badFirst = { ...sound, prd: clientOnlyPrd, stack: "Next.js + Supabase + TypeScript" };
    const fixedSecond = { ...sound, prd: clientOnlyPrd, stack: "Vite + React + TypeScript (static export)" };

    test("Supabase first, backend-free stack second → two rounds, ready, final stack is clean", async () => {
      const designs = [badFirst, fixedSecond];
      let i = 0;
      const architect: Architect = async () => designs[Math.min(i++, designs.length - 1)]!;
      const r = await architectApp(clientOnlyPrd, { architect });
      expect(r.rounds).toBe(2);
      expect(r.ready).toBe(true);
      expect(r.arch.stack).toBe("Vite + React + TypeScript (static export)");
    });

    test("architect NEVER drops Supabase → stops at budget, not ready, with the right gap", async () => {
      const architect: Architect = async () => badFirst;
      const r = await architectApp(clientOnlyPrd, { architect, budget: 2 });
      expect(r.rounds).toBe(2);
      expect(r.ready).toBe(false);
      expect(r.gaps.some((g) => g.ruleId === "client-only-app-has-backend")).toBe(true);
    });
  });
});
