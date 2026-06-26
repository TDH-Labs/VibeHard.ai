import { afterEach, describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerceDataModel } from "./model.ts";
import { generateBackend } from "./generate.ts";
import { runMigrate } from "../gate/migrate.ts";
import { runRlsEnforcement } from "../gate/rls-enforce.ts";

// Every REAL captured architect model (fixtures/architect-models/*.json) must generate a backend that
// applies AND proves tenant isolation. This is the proactive corpus — it grows from live runs, so the
// suite catches the next unseen shape instead of only the four shapes already remembered (audit D1/M4).
const CORPUS_DIR = join(import.meta.dir, "..", "..", "fixtures", "architect-models");

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function project(): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-corpus-"));
  tmps.push(d);
  mkdirSync(join(d, "supabase"), { recursive: true });
  return d;
}

const models = [...new Glob("*.json").scanSync({ cwd: CORPUS_DIR })].sort();

describe("captured-model corpus — every real model isolates by construction", () => {
  test("the corpus is non-empty (someone could delete the fixtures and the suite would go vacuously green)", () => {
    expect(models.length).toBeGreaterThan(0);
  });

  for (const file of models) {
    test(`${file}: generates → applies (migrate) → isolates (rls-enforce)`, async () => {
      const model = coerceDataModel(JSON.parse(readFileSync(join(CORPUS_DIR, file), "utf8")));
      const dir = project();
      generateBackend(dir, model);
      const mig = await runMigrate(dir);
      if (mig.status !== "pass") console.error(`${file} migrate:`, JSON.stringify(mig.findings, null, 2));
      expect(mig.status).toBe("pass");
      const enf = await runRlsEnforcement(dir, model);
      if (enf.status === "block") console.error(`${file} rls-enforce:`, JSON.stringify(enf.findings, null, 2));
      expect(enf.status).not.toBe("block"); // pass or n/a (a single-tenant model), never a proven leak
    });
  }
});
