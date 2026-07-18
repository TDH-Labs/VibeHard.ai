/**
 * Golden templates (Phase 1 of the ship-rate plan) — the structural fix for the boilerplate
 * failure class. Seven consecutive live failures (Supabase forced onto client-only apps, plans
 * omitting package.json / app/layout.tsx, always-true Tailwind detection, a workstream silently
 * writing zero skeleton files, a Dockerfile guessing the wrong port) were ALL the LLM being
 * trusted to produce project BOILERPLATE from scratch, per-build. Feature code was rarely the
 * blocker; boilerplate was.
 *
 * So boilerplate is now VENDORED, not generated: a complete, pinned-dependency, building,
 * booting app skeleton is copied into the workspace before codegen, and the LLM plans + writes
 * FEATURES ONLY. Same pattern as the deterministic backend (generate.ts writes migrations/RLS/
 * clients from a typed model; template-owned paths are pruned from workstreams) — this extends
 * it from the data layer to the whole skeleton. Templates are tested product code: CI proves
 * each one `npm ci && npm run build` + boots green.
 *
 * Ownership boundary: `isTemplateOwnedPath` matches ROLE-equivalents, not just exact names —
 * a codegen-authored next.config.js would silently SHADOW the template's next.config.mjs
 * (Next.js prefers .js), so every spelling of a template-owned role is owned. app/page.tsx is
 * deliberately NOT owned: it's the feature surface, and workstreams must overwrite it.
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type TemplateKey = "next-static-client-only" | "next-supabase";

export interface AppTemplate {
  key: TemplateKey;
  /** The stack this template IS — the architect is told, not asked. */
  stack: string;
  /** Exact workspace-relative paths the template ships (for logs/messages). */
  files: string[];
}

/** Role-equivalent patterns for paths the template owns regardless of spelling. Shared by the
 *  workstream pruning (cli.ts) and the architecture review (template-owned-path finding). */
const OWNED_PATTERNS: RegExp[] = [
  /^package(-lock)?\.json$/,
  /^bun\.lockb?$/,
  /^(yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/,
  /^tsconfig(\..+)?\.json$/,
  /^next\.config\.(js|cjs|mjs|ts)$/,
  /^next-env\.d\.ts$/,
  /^postcss\.config\.(js|cjs|mjs|ts|json)$/,
  /^tailwind\.config\.(js|cjs|mjs|ts)$/,
  /^(src\/)?app\/layout\.(tsx|jsx|ts|js)$/,
  /^(src\/)?app\/globals\.css$/,
  /^(src\/)?styles\/globals\.css$/, // pages-era spelling of the same role
  /^Dockerfile$/,
  /^\.dockerignore$/,
  /^\.gitignore$/,
  /^readme(\.md)?$/i,
  /^server\.(js|mjs|cjs|ts)$/, // the container entry — the static template ships it; a generated one re-guesses the port contract
  /^\.env\.example$/,
];

/** Normalize an LLM-planned path the way the engine writes them (leading "./" or "/" = root). */
function normalizePath(f: string): string {
  return f.replace(/^\.?\/+/, "");
}

/** Is `file` (a planned workstream path) owned by the template — i.e. hands-off for codegen? */
export function isTemplateOwnedPath(file: string): boolean {
  const p = normalizePath(file);
  return OWNED_PATTERNS.some((re) => re.test(p));
}

const SHARED_FILES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "next.config.mjs",
  "next-env.d.ts",
  "postcss.config.mjs",
  "tailwind.config.ts",
  "app/layout.tsx",
  "app/globals.css",
  "app/page.tsx", // shipped as a placeholder, NOT owned — feature codegen overwrites it
  "public/robots.txt",
  "Dockerfile",
  ".dockerignore",
  ".gitignore",
  "README.md",
];

export const TEMPLATES: Record<TemplateKey, AppTemplate> = {
  "next-static-client-only": {
    key: "next-static-client-only",
    stack: "Next.js (static export) + TypeScript + Tailwind CSS",
    files: [...SHARED_FILES, "server.js"],
  },
  "next-supabase": {
    key: "next-supabase",
    stack: "Next.js + Supabase + TypeScript + Tailwind CSS",
    files: [...SHARED_FILES, ".env.example"],
  },
};

/** Which template fits the SPEC (not the stack string — files are ground truth, and the spec's
 *  deterministic flags are set before the architect ever runs). Null → no template: the app
 *  isn't a hosted JS web app (downloadable tools ship no skeleton we vendor yet; Python is the
 *  caller's env-gated path). */
export function pickTemplate(spec: { deployTarget?: string; clientOnlyStorage?: boolean; storesData?: boolean }): AppTemplate | null {
  if (spec.deployTarget === "downloadable-tool") return null;
  if (spec.clientOnlyStorage === true || spec.storesData === false) return TEMPLATES["next-static-client-only"];
  return TEMPLATES["next-supabase"];
}

/** Where the vendored templates live (repo-relative; shipped in the platform image via COPY . .). */
export function templateDir(key: TemplateKey): string {
  return join(import.meta.dir, "..", "..", "templates", key);
}

const COPY_SKIP = new Set(["node_modules", ".next", "out", "dist", ".git", ".vibehard"]);

/** Copy the template into the workspace WITHOUT overwriting anything that already exists —
 *  idempotent across resumes, and a re-run never clobbers themed configs (the design scaffold
 *  rewrites tailwind.config.ts/globals.css after codegen) or generated work. Returns the number
 *  of files copied. Throws if the template directory is missing entirely (a packaging bug —
 *  fail loudly, not with a silently skeleton-less build). */
export function applyTemplate(target: string, tpl: AppTemplate, srcDir: string = templateDir(tpl.key)): number {
  if (!existsSync(srcDir)) {
    throw new Error(`template "${tpl.key}" not found at ${srcDir} — the platform image is missing its vendored templates`);
  }
  let copied = 0;
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(srcDir, rel), { withFileTypes: true })) {
      if (COPY_SKIP.has(e.name)) continue;
      const relPath = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        walk(relPath);
        continue;
      }
      const dest = join(target, relPath);
      if (existsSync(dest)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(srcDir, relPath), dest);
      copied++;
    }
  };
  walk("");
  return copied;
}

/** Persist which template scaffolded this workspace (.vibehard/template.json) — ground truth
 *  for every LATER pipeline stage (the fix loop, change/refine) that needs to know, without
 *  re-deriving the decision (and its env gates) from scratch. */
export function persistWorkspaceTemplate(target: string, tpl: AppTemplate): void {
  const dir = join(target, ".vibehard");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.json"), JSON.stringify({ key: tpl.key }, null, 2));
}

/** Which template scaffolded this workspace, if any (null: pre-template build, no marker, or a
 *  marker naming a template this platform version doesn't know). */
export function readWorkspaceTemplate(workspacePath: string): AppTemplate | null {
  try {
    const raw = JSON.parse(readFileSync(join(workspacePath, ".vibehard", "template.json"), "utf8")) as { key?: string };
    return raw.key && raw.key in TEMPLATES ? TEMPLATES[raw.key as TemplateKey] : null;
  } catch {
    return null;
  }
}

/** The fix loop's variant of the hands-off block — SOFTER than codegen's, deliberately: the
 *  fixer must be able to touch a skeleton file when a finding points at it (a themed config
 *  can genuinely break a build). What it must never do is what e2e-9's fixer did: improvise
 *  wholesale replacements for boilerplate that is already verified. */
export function fixerTemplateBlock(tpl: AppTemplate): string {
  return (
    `\n\nPROJECT SKELETON IS FROM A VERIFIED TEMPLATE (${tpl.stack}): package.json (pinned dependencies + a real lockfile), tsconfig.json, next.config.mjs, postcss/tailwind configs, app/layout.tsx, app/globals.css, README, Dockerfile` +
    `${tpl.key === "next-static-client-only" ? ", server.js" : ""} are known-good. ` +
    `Fix FEATURE code first. Touch a skeleton file ONLY when a finding explicitly points at it — change the minimum, never rewrite it wholesale, never replace it with a variant spelling (no next.config.js, no tailwind.config.js, no pages/ directory), never delete it, never hand-author a lockfile. ` +
    `Deploy contract: the platform injects PORT (default 8080) and routes traffic there — the app must listen on process.env.PORT; never pin a different port.`
  );
}

/** The system-prompt block telling codegen the skeleton EXISTS and is hands-off. A prompt is a
 *  hint, not enforcement — the enforcement is the workstream pruning + the review check — but
 *  the model still needs to know the layout it's building into. */
export function templateBlock(tpl: AppTemplate): string {
  return (
    `\n\nPROJECT SKELETON ALREADY EXISTS — do NOT re-create it. This workspace was scaffolded from a verified template (${tpl.stack}): ` +
    `package.json (pinned dependencies + a real lockfile), tsconfig.json, next.config.mjs, postcss/tailwind configs, app/layout.tsx, app/globals.css, README, Dockerfile` +
    `${tpl.key === "next-static-client-only" ? ", and server.js (the container entry — it serves the static export and honors the platform's PORT contract)" : ""}. ` +
    `Do NOT re-author ANY of those files, and do NOT create variants of them (no next.config.js, no tailwind.config.js, no second globals.css, no Dockerfile, no lockfile). ` +
    `Write ONLY feature files: pages under app/ (App Router — app/page.tsx is yours to overwrite; never use a pages/ directory), components/, hooks/, lib/. ` +
    `Import the global stylesheet ONLY via the existing app/layout.tsx (already wired). ` +
    `If a feature genuinely needs a new npm dependency, emit a package.json containing ONLY that dependency entry — it is MERGED into the existing manifest (dependencies union; the template's scripts and entry points stay authoritative). Never restate the template's own dependencies or scripts.`
  );
}
