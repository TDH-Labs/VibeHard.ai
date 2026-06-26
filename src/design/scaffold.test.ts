import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldDesignSystem } from "./scaffold.ts";
import { designPreset } from "./presets.ts";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});
function app(opts: { tailwind?: boolean } = { tailwind: true }): string {
  const d = mkdtempSync(join(tmpdir(), "vibehard-ds-"));
  tmps.push(d);
  mkdirSync(join(d, "app"), { recursive: true });
  writeFileSync(join(d, "app", "globals.css"), "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n");
  writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: opts.tailwind ? { next: "15", tailwindcss: "^3.4.0" } : { next: "15" } }));
  return d;
}

describe("design scaffold — premium by default, deterministic", () => {
  test("the DEFAULT preset is premium (serif headings + a non-generic accent), not bland slate+blue", () => {
    const p = designPreset(undefined);
    expect(p.tokens.serifHeadings).toBe(true); // headings get a display serif — the premium lever
    expect(p.tokens.accent[600]).not.toBe("#2563eb"); // not the old generic blue
    expect(p.tokens.displayFont).toBeTruthy();
  });

  test("writes a themed tailwind.config + a premium globals.css for a Tailwind app", () => {
    const dir = app();
    const r = scaffoldDesignSystem(dir, "warm");
    expect(r.applied).toBe(true);
    expect(r.preset).toBe("warm");

    const tw = readFileSync(join(dir, "tailwind.config.ts"), "utf8");
    const t = designPreset("warm").tokens;
    expect(tw).toContain(t.accent[600]); // the dusty-rose accent is in the theme
    expect(tw).toContain("accent:");
    expect(tw).toContain("slate:"); // neutral remapped onto slate-* so the app re-themes
    expect(tw).toContain("display:"); // a display font family

    const css = readFileSync(join(dir, "app", "globals.css"), "utf8");
    expect(css).toContain("fonts.googleapis.com"); // fonts actually loaded, not hoped-for
    expect(css).toContain(t.displayFont.replace(/\s/g, "+"));
    expect(css).toContain("font-family: var(--font-display)"); // serif headings rule
    expect(css).toContain(".btn-primary"); // styled component classes the codegen uses
    expect(css).toContain(".card");
    expect(css).toContain("@apply bg-accent");
  });

  test("each preset produces a DISTINCT accent (the picker actually changes the look)", () => {
    const accents = new Set<string>();
    for (const key of ["clean", "warm", "bold", "professional"]) {
      const dir = app();
      scaffoldDesignSystem(dir, key);
      const tw = readFileSync(join(dir, "tailwind.config.ts"), "utf8");
      const m = tw.match(/accent: \{ DEFAULT: '([^']+)'/);
      accents.add(m![1]!);
    }
    expect(accents.size).toBe(4); // four distinct accents
  });

  test("no-op for a non-Tailwind app (don't impose Tailwind where it isn't used)", () => {
    const dir = app({ tailwind: false });
    expect(scaffoldDesignSystem(dir).applied).toBe(false);
    expect(existsSync(join(dir, "tailwind.config.ts"))).toBe(false);
  });
});

import { pickDesignPreset } from "./presets.ts";
describe("pickDesignPreset — auto-pick by domain", () => {
  test("childcare (even with health records) → warm, not corporate", () => {
    expect(pickDesignPreset({ name: "ProCare", summary: "childcare management with immunization records", features: ["attendance"], sensitiveData: ["phi"] })).toBe("warm");
  });
  test("finance/legal/health-practice → professional", () => {
    expect(pickDesignPreset({ summary: "invoicing and accounting for a law firm", sensitiveData: ["financial"] })).toBe("professional");
    expect(pickDesignPreset({ summary: "patient intake for a medical clinic" })).toBe("professional");
  });
  test("marketing/launch → bold; generic → clean default", () => {
    expect(pickDesignPreset({ summary: "a startup landing page with a waitlist" })).toBe("bold");
    expect(pickDesignPreset({ summary: "an internal tool to track widgets" })).toBe("clean");
  });
});
