import { expect, test } from "bun:test";
import { VERSION } from "./cli.ts";

// Skeleton smoke test — keeps `bun test` green from commit one.
// M1 replaces/expands this with real gate tests (PROJECT_BRIEF.md §8–9).
test("version is a semver string", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
