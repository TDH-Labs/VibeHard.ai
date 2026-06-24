import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EscalationPacket } from "../escalation/packet.ts";
import { FileReviewerStore, makeReviewer, matchesPacket, parseSpecialties, type Reviewer } from "./reviewer.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-reviewer-test-"));
  dirs.push(d);
  return d;
}

function packet(specialties: EscalationPacket["specialties"]): EscalationPacket {
  return { workspacePath: "/app", createdAt: "t", reason: "blocked", items: [], specialties, blocking: 1 };
}

describe("parseSpecialties", () => {
  test("keeps valid, dedupes, lowercases", () => {
    expect(parseSpecialties(["Security", "security", "database"])).toEqual({ specialties: ["security", "database"], invalid: [] });
  });
  test("reports invalid, never silently drops", () => {
    expect(parseSpecialties(["security", "frontend"])).toEqual({ specialties: ["security"], invalid: ["frontend"] });
  });
  test("empty input defaults to generalist", () => {
    expect(parseSpecialties([])).toEqual({ specialties: ["general"], invalid: [] });
  });
  test("all-invalid input does NOT default (so the caller can error)", () => {
    expect(parseSpecialties(["nope"])).toEqual({ specialties: [], invalid: ["nope"] });
  });
});

describe("makeReviewer", () => {
  test("slugs the name into a stable id, active by default", () => {
    const r = makeReviewer("Ada Lovelace", ["security"], "t");
    expect(r.id).toBe("rev-ada-lovelace");
    expect(r.status).toBe("active");
    expect(r.specialties).toEqual(["security"]);
  });
});

describe("matchesPacket (routing moat)", () => {
  const sec = makeReviewer("Sec Person", ["security"], "t");
  test("qualifies when a specialty overlaps", () => {
    expect(matchesPacket(sec, packet(["security"]))).toBe(true);
  });
  test("refuses when no specialty overlaps", () => {
    expect(matchesPacket(sec, packet(["database"]))).toBe(false);
  });
  test("refuses an inactive reviewer even with an overlap", () => {
    const inactive: Reviewer = { ...sec, status: "inactive" };
    expect(matchesPacket(inactive, packet(["security"]))).toBe(false);
  });
  test("fail-closed: refuses an unrouted packet (no specialties) for everyone", () => {
    const generalist = makeReviewer("Jack", ["security", "database", "reliability", "general"], "t");
    expect(matchesPacket(generalist, packet([]))).toBe(false);
  });
});

describe("FileReviewerStore", () => {
  test("create / get / list / dup-guard", () => {
    const store = new FileReviewerStore(tmp());
    const r = makeReviewer("Grace", ["reliability"], "t");
    store.create(r);
    expect(store.get(r.id)).toEqual(r);
    expect(store.list().map((x) => x.id)).toEqual([r.id]);
    expect(() => store.create(r)).toThrow(/already exists/);
    expect(store.get("rev-nobody")).toBeNull();
  });
});
