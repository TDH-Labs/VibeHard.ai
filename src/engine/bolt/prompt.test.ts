import { describe, expect, test } from "bun:test";
import { VIBEHARD_SYSTEM_PROMPT, PYTHON_SYSTEM_PROMPT, selectSystemPrompt } from "./prompt.ts";

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
