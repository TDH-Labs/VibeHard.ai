import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalPath, readJournal, recordNote, recordRound, seedJournal } from "./journal.ts";

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});
async function ws(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "vibehard-journal-"));
  tmps.push(d);
  return d;
}

describe("as-built journal", () => {
  test("seed writes intended app + stack, once (idempotent)", async () => {
    const d = await ws();
    seedJournal(d, { name: "ProCare", summary: "child care platform", stack: "Next.js + Supabase" });
    const first = readFileSync(journalPath(d), "utf8");
    expect(first).toContain("As-Built Journal — ProCare");
    expect(first).toContain("Stack: Next.js + Supabase");
    seedJournal(d, { name: "DIFFERENT" }); // must NOT clobber
    expect(readFileSync(journalPath(d), "utf8")).toBe(first);
  });

  test("recordRound appends localized findings the fixer can read back", async () => {
    const d = await ws();
    seedJournal(d, { name: "app" });
    recordRound(d, 1, "verify(2)", [
      { tool: "verify", ruleId: "build-failed", severity: "high", file: "lib/x.ts", line: 4, message: "type error" },
    ]);
    const j = readJournal(d);
    expect(j).toContain("Round 1 — blocked by verify(2)");
    expect(j).toContain("lib/x.ts:4 — type error");
  });

  test("recordNote appends free-form context (e.g. a reconcile)", async () => {
    const d = await ws();
    seedJournal(d, { name: "app" });
    recordNote(d, "Architecture reconciled: Clerk → Supabase Auth.");
    expect(readJournal(d)).toContain("Clerk → Supabase Auth");
  });

  test("readJournal is empty before seeding (no crash)", async () => {
    expect(readJournal(await ws())).toBe("");
  });
});
