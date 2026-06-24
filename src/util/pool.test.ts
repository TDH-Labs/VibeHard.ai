import { describe, expect, test } from "bun:test";
import { mapPool, runTiers } from "./pool.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

describe("mapPool", () => {
  test("preserves result order regardless of completion order", async () => {
    // later items resolve sooner → still ordered by input position
    const out = await mapPool([30, 20, 10], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out).toEqual([30, 20, 10]);
  });

  test("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapPool(Array.from({ length: 10 }, (_, i) => i), 3, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // actually ran concurrently
  });

  test("runs every item exactly once", async () => {
    const seen: number[] = [];
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (x) => {
      seen.push(x);
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  test("handles limit larger than item count and a single item", async () => {
    expect(await mapPool([7], 8, async (x) => x + 1)).toEqual([8]);
    expect(await mapPool([], 4, async (x) => x)).toEqual([]);
  });

  test("propagates a thrown fn", async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      }),
    ).rejects.toThrow(/boom/);
  });
});

describe("runTiers (codegen orchestration)", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 1));

  test("tiers run sequentially; each item sees ONLY earlier tiers in builtSoFar", async () => {
    const tiers = [["a", "b"], ["c"], ["d", "e"]];
    const sawBuilt: Record<string, string[]> = {};
    const ok = await runTiers(tiers, 4, async (ws, built) => {
      sawBuilt[ws] = [...built];
      return true;
    });
    expect(ok).toBe(true);
    expect(sawBuilt.a).toEqual([]); // tier 0 sees nothing
    expect(sawBuilt.b).toEqual([]); // sibling not visible
    expect((sawBuilt.c ?? []).sort()).toEqual(["a", "b"]); // tier 1 sees all of tier 0
    expect((sawBuilt.d ?? []).sort()).toEqual(["a", "b", "c"]); // tier 2 sees tiers 0+1, not sibling e
    expect((sawBuilt.e ?? []).sort()).toEqual(["a", "b", "c"]);
  });

  test("within a tier runs concurrently, bounded by the cap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runTiers([["a", "b", "c", "d", "e"]], 2, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight--;
      return true;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(2);
  });

  test("any failed item fails the build and STOPS later tiers", async () => {
    const ran: string[] = [];
    const ok = await runTiers([["a", "b"], ["c"]], 4, async (ws) => {
      ran.push(ws);
      return ws !== "b"; // b fails
    });
    expect(ok).toBe(false);
    expect(ran).not.toContain("c"); // tier 1 never started after tier 0 failed
  });
});
