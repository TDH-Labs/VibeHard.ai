import { describe, expect, test } from "bun:test";
import { VIBEHARD_SYSTEM_PROMPT, PYTHON_SYSTEM_PROMPT, DOWNLOADABLE_TOOL_SYSTEM_PROMPT, selectSystemPrompt } from "./prompt.ts";

describe("selectSystemPrompt", () => {
  test("Python/FastAPI/Flask stacks → the Python prompt", () => {
    for (const s of ["FastAPI + Supabase", "Python + Supabase", "Flask API + Supabase", "python/uvicorn", "Django + Supabase"]) {
      expect(selectSystemPrompt(s)).toBe(PYTHON_SYSTEM_PROMPT);
    }
  });
  test("JS/TS stacks → the default TypeScript prompt", () => {
    for (const s of ["Next.js + Supabase", "Vite + React + Supabase", "Express + Postgres + React"]) {
      expect(selectSystemPrompt(s)).toBe(VIBEHARD_SYSTEM_PROMPT);
    }
  });
  test("deployTarget 'downloadable-tool' → the downloadable-tool prompt, regardless of stack text", () => {
    for (const s of ["Node.js + TypeScript + SQLite", "Node.js + TypeScript + Ink (TUI) + SQLite", "Python + Click"]) {
      expect(selectSystemPrompt(s, "downloadable-tool")).toBe(DOWNLOADABLE_TOOL_SYSTEM_PROMPT);
    }
  });
  test("deployTarget 'hosted-app' or omitted → unaffected (existing one-arg call sites keep working)", () => {
    expect(selectSystemPrompt("Next.js + Supabase", "hosted-app")).toBe(VIBEHARD_SYSTEM_PROMPT);
    expect(selectSystemPrompt("FastAPI + Supabase", "hosted-app")).toBe(PYTHON_SYSTEM_PROMPT);
    expect(selectSystemPrompt("Next.js + Supabase")).toBe(VIBEHARD_SYSTEM_PROMPT);
  });
});

describe("PYTHON_SYSTEM_PROMPT — the load-bearing rules are present", () => {
  test("RLS-as-boundary: access user data with the user's token, NEVER the service-role key", () => {
    expect(PYTHON_SYSTEM_PROMPT).toMatch(/sb\.postgrest\.auth/);
    expect(PYTHON_SYSTEM_PROMPT).toMatch(/NEVER use SUPABASE_SERVICE_ROLE_KEY/);
    expect(PYTHON_SYSTEM_PROMPT).toMatch(/BYPASS/);
  });
  test("container shape: a Dockerfile running uvicorn on PORT (so Fly deploys + verify probes it)", () => {
    expect(PYTHON_SYSTEM_PROMPT).toMatch(/Dockerfile/);
    expect(PYTHON_SYSTEM_PROMPT).toMatch(/uvicorn main:app/);
    expect(PYTHON_SYSTEM_PROMPT).toMatch(/PORT/);
  });
  test("keeps the gate-critical SQL-injection + RLS migration rules", () => {
    expect(PYTHON_SYSTEM_PROMPT).toMatch(/enable row level security/i);
    expect(PYTHON_SYSTEM_PROMPT).toMatch(/parameterized/i);
    expect(PYTHON_SYSTEM_PROMPT).toMatch(/using \(true\)/); // names the forbidden permissive policy
  });
});

describe("DOWNLOADABLE_TOOL_SYSTEM_PROMPT — the load-bearing rules are present", () => {
  test("entry-point contract matches verify.ts's findEntry/runCliOnce: main field, plain JS, isTTY branch", () => {
    expect(DOWNLOADABLE_TOOL_SYSTEM_PROMPT).toMatch(/"main"/);
    expect(DOWNLOADABLE_TOOL_SYSTEM_PROMPT).toMatch(/never looks at `bin`/);
    expect(DOWNLOADABLE_TOOL_SYSTEM_PROMPT).toMatch(/process\.stdin\.isTTY/);
    expect(DOWNLOADABLE_TOOL_SYSTEM_PROMPT).toMatch(/no compile step/);
  });
  test("no hosted substrate: Supabase named only as a prohibition, no Dockerfile/deploy config, local persistence only", () => {
    expect(DOWNLOADABLE_TOOL_SYSTEM_PROMPT).toMatch(/no hosted database, no Supabase/);
    expect(DOWNLOADABLE_TOOL_SYSTEM_PROMPT).toMatch(/Do NOT add.*Dockerfile/);
    expect(DOWNLOADABLE_TOOL_SYSTEM_PROMPT).toMatch(/better-sqlite3/);
  });
  test("no-auth-by-default for a single-user local tool", () => {
    expect(DOWNLOADABLE_TOOL_SYSTEM_PROMPT).toMatch(/Do NOT add authentication/);
  });
  test("keeps the universal protocol + SQL-injection rule", () => {
    expect(DOWNLOADABLE_TOOL_SYSTEM_PROMPT).toMatch(/boltArtifact/);
    expect(DOWNLOADABLE_TOOL_SYSTEM_PROMPT).toMatch(/parameterized/i);
    expect(DOWNLOADABLE_TOOL_SYSTEM_PROMPT).toMatch(/NEVER use the word "artifact" in prose/);
  });
});
