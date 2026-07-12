/**
 * Deterministic design-system scaffold. The presets carry concrete tokens; this writes them into the
 * app as real files so the chosen look is GUARANTEED, not left to the model:
 *   • tailwind.config.ts — the accent palette, the neutral scale remapped onto `slate-*`, and the
 *     display/body font families. Every utility class (bg-accent, text-slate-900, font-display)
 *     resolves through this, so the whole app re-themes even if the model never "tried" to.
 *   • globals.css — Google-Fonts import, the design tokens, serif/display headings, and premium
 *     component classes (.btn/.card/.input/.label/.chip).
 * Same philosophy as scaffoldConfigs: boilerplate the model shouldn't be trusted to get right is
 * written in code. Idempotent; only runs for a Tailwind app.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { designPreset, type DesignTokens } from "./presets.ts";

function hexToRgbTriple(hex: string): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}
const googleFamily = (name: string): string => name.trim().replace(/\s+/g, "+");

function globalsCss(t: DesignTokens): string {
  const displayStack = t.serifHeadings ? `'${t.displayFont}', Georgia, serif` : `'${t.displayFont}', system-ui, sans-serif`;
  return `@import url('https://fonts.googleapis.com/css2?family=${googleFamily(t.displayFont)}:wght@400;500;600;700&family=${googleFamily(t.bodyFont)}:wght@400;500;600;700&display=swap');
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --font-display: ${displayStack};
  --font-sans: '${t.bodyFont}', system-ui, sans-serif;
  --background: ${hexToRgbTriple(t.neutral[50])};
  --foreground: ${hexToRgbTriple(t.neutral[900])};
  --radius: ${t.radius};
}

html,
body {
  background-color: rgb(var(--background));
  color: rgb(var(--foreground));
  font-family: var(--font-sans);
}

@layer base {
  /* The single biggest "premium" lever — headings in the display font. */
  h1,
  h2,
  h3 {
    font-family: var(--font-display);
    letter-spacing: -0.01em;
  }
}

@layer components {
  .btn {
    @apply inline-flex items-center justify-center rounded-[var(--radius)] px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed;
  }
  .btn-primary {
    @apply bg-accent text-white hover:bg-accent-700;
  }
  .btn-secondary {
    @apply border border-slate-200 bg-white text-slate-700 hover:bg-slate-50;
  }
  .btn-danger {
    @apply bg-red-600 text-white hover:bg-red-700;
  }
  .input {
    @apply w-full rounded-[var(--radius)] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent;
  }
  .label {
    @apply mb-1 block text-sm font-medium text-slate-700;
  }
  .card {
    @apply rounded-[calc(var(--radius)+0.25rem)] border border-slate-200/80 bg-white shadow-sm;
  }
  .chip {
    @apply inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium;
  }
}
`;
}

function tailwindConfigTs(t: DesignTokens): string {
  const display = t.serifHeadings ? "'Georgia', 'serif'" : "'system-ui', 'sans-serif'";
  return `import type { Config } from 'tailwindcss';

// Scaffolded by VibeHard's design system — the accent + neutral + fonts that theme the whole app.
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}', './src/**/*.{ts,tsx}', './pages/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', ${display}],
      },
      colors: {
        accent: { DEFAULT: '${t.accent[600]}', 50: '${t.accent[50]}', 100: '${t.accent[100]}', 600: '${t.accent[600]}', 700: '${t.accent[700]}' },
        // Neutral scale remapped onto slate-* so existing slate utility classes inherit the theme.
        slate: ${JSON.stringify(t.neutral)},
      },
    },
  },
  plugins: [],
};

export default config;
`;
}

/** Resolve the app's global stylesheet path (App Router or src/). */
function globalsPath(target: string): string {
  for (const p of ["app/globals.css", "src/app/globals.css", "styles/globals.css", "src/styles/globals.css"]) {
    if (existsSync(join(target, p))) return join(target, p);
  }
  return join(target, "app/globals.css"); // App-Router default
}

export interface DesignScaffoldResult {
  applied: boolean;
  preset: string;
}

/** Write the chosen design system into a Tailwind app. No-op for non-Tailwind apps. */
export function scaffoldDesignSystem(target: string, presetKey: string | undefined = process.env.VIBEHARD_DESIGN): DesignScaffoldResult {
  const pkgPath = join(target, "package.json");
  if (!existsSync(pkgPath)) return { applied: false, preset: "" };
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return { applied: false, preset: "" };
  }
  const usesTailwind = !!deps.tailwindcss || !!deps["@tailwindcss/postcss"] || existsSync(join(target, "tailwind.config.ts")) || existsSync(join(target, "tailwind.config.js"));
  if (!usesTailwind) return { applied: false, preset: "" };

  const preset = designPreset(presetKey);
  // One canonical tailwind config (drop a competing .js so the theme is unambiguous).
  for (const f of ["tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs"]) {
    const p = join(target, f);
    if (existsSync(p)) rmSync(p);
  }
  writeFileSync(join(target, "tailwind.config.ts"), tailwindConfigTs(preset.tokens));
  // THE BUG THIS CLOSES (found live 2026-07-12): globalsPath()'s App-Router default (app/globals.css)
  // assumes an app/ directory already exists — true whenever some workstream owns app/page.tsx or
  // similar, but NOT when the plan never touches app/ at all (observed live: a Next.js static-export
  // plan whose workstreams covered only hooks/components/services, no app/ file anywhere).
  // writeFileSync never creates parent directories — it threw, and per this run's actual behavior
  // that exception propagated all the way to (and was reported by) the verify gate's build-failure
  // path as an ENOENT on the very file this scaffold was supposed to guarantee.
  const css = globalsPath(target);
  mkdirSync(dirname(css), { recursive: true });
  writeFileSync(css, globalsCss(preset.tokens));
  return { applied: true, preset: preset.key };
}
