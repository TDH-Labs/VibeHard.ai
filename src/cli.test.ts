import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION, teeToLogFile } from "./cli.ts";

// Skeleton smoke test — keeps `bun test` green from commit one.
// M1 replaces/expands this with real gate tests (PROJECT_BRIEF.md §8–9).
test("version is a semver string", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

describe("teeToLogFile — 2026-07-09 durable per-workspace build log", () => {
  // teeToLogFile permanently monkey-patches console.log/console.error for the REAL CLI's
  // lifetime (correct there — a real invocation runs once, then the process exits). Bun's
  // console.log does NOT call through process.stdout.write — verified directly — so the
  // console methods themselves are the only reliable interception point, and the ONLY two
  // this file actually calls (confirmed via grep — no console.warn/info anywhere in cli.ts).
  // A test process runs MANY tests in one process, so every test that patches them MUST
  // restore the originals afterward, or every later test's output silently keeps getting
  // appended to this test's temp log file for the rest of the whole test run.
  const origLog = console.log;
  const origError = console.error;
  const dirs: string[] = [];
  afterEach(() => {
    console.log = origLog;
    console.error = origError;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dir = (): string => {
    const d = mkdtempSync(join(tmpdir(), "vibehard-teelog-"));
    dirs.push(d);
    return d;
  };

  test("creates .vibehard/build.log with a header line naming the invocation", () => {
    const d = dir();
    teeToLogFile(d);
    const log = readFileSync(join(d, ".vibehard", "build.log"), "utf8");
    expect(log).toMatch(/^── \d{4}-\d{2}-\d{2}T.*──\n$/);
  });

  test("console.log output reaches BOTH the real console AND the log file — teeing, not redirecting", () => {
    const d = dir();
    // Install a spy BEFORE teeToLogFile runs, so teeToLogFile's own wrapper calls through to
    // THIS spy (standing in for "the real terminal") — proves the tee adds a destination
    // rather than replacing the original one.
    let capturedByRealConsole = "";
    console.log = (...args: unknown[]) => {
      capturedByRealConsole += args.join(" ");
    };
    teeToLogFile(d);
    console.log("hello from the build");
    const log = readFileSync(join(d, ".vibehard", "build.log"), "utf8");
    expect(log).toContain("hello from the build");
    expect(capturedByRealConsole).toContain("hello from the build"); // the spy still received it too
  });

  test("console.error is also captured, independently of console.log", () => {
    const d = dir();
    teeToLogFile(d);
    console.error("a real error line");
    const log = readFileSync(join(d, ".vibehard", "build.log"), "utf8");
    expect(log).toContain("a real error line");
  });

  test("a fresh call TRUNCATES rather than appends across separate invocations", () => {
    const d = dir();
    teeToLogFile(d);
    console.log("first run's output");
    console.log = origLog; // restore before re-teeing, matching real CLI usage (one call per process)
    console.error = origError;
    teeToLogFile(d);
    const log = readFileSync(join(d, ".vibehard", "build.log"), "utf8");
    expect(log).not.toContain("first run's output"); // the header wipe cleared it
    expect(log).toMatch(/^── \d{4}-\d{2}-\d{2}T.*──\n$/);
  });

  test("a workspace whose .vibehard/ can't be created never throws — best-effort only", () => {
    // A path that can't possibly be created (nested under a file, not a directory) — the
    // function must swallow this, not crash the real build over a logging failure.
    const d = dir();
    const impossible = join(d, "not-a-dir-because-this-is-a-file");
    writeFileSync(impossible, "x");
    expect(() => teeToLogFile(join(impossible, "nested", "deeper"))).not.toThrow();
  });
});
