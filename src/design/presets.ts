/**
 * Design presets (backlog #12). VibeHard's codegen used to emit whatever the base model defaulted
 * to. The original presets were PROMPT-ONLY ("use a warm palette") — and the model diluted them to a
 * generic slate+blue+Inter look (shipped on ProCare). For a NON-TECHNICAL audience, design can't be
 * "ask the model to make it pretty" OR even "describe the palette"; it has to be DETERMINISTIC.
 *
 * So a preset is now CONCRETE TOKENS (exact accent palette, neutral scale, display + body fonts,
 * radius) that `scaffoldDesignSystem` writes into every app as real files — a themed tailwind config
 * + a premium globals.css with the design tokens, serif/display headings, and styled component
 * classes. Every app inherits the look REGARDLESS of what the model emits, because utility classes
 * (bg-accent, text-slate-900, font-display) resolve through the scaffolded theme. The prompt block
 * (designBlock) then just tells the model the system exists and to use it.
 *
 * Pure data + helpers. The scaffolder consumes `tokens`; `designBlock()` consumes the prose.
 */

/** A 10-step neutral scale (50→900) as "R G B" triples for CSS rgb(var(--x)). */
export type NeutralScale = Record<50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900, string>;

// Warm (stone) reads premium + human; cool (slate) reads corporate/technical; zinc is neutral-modern.
const STONE: NeutralScale = { 50: "#fafaf9", 100: "#f5f5f4", 200: "#e7e5e4", 300: "#d6d3d1", 400: "#a8a29e", 500: "#78716c", 600: "#57534e", 700: "#44403c", 800: "#292524", 900: "#1c1917" };
const SLATE: NeutralScale = { 50: "#f8fafc", 100: "#f1f5f9", 200: "#e2e8f0", 300: "#cbd5e1", 400: "#94a3b8", 500: "#64748b", 600: "#475569", 700: "#334155", 800: "#1e293b", 900: "#0f172a" };
const ZINC: NeutralScale = { 50: "#fafafa", 100: "#f4f4f5", 200: "#e4e4e7", 300: "#d4d4d8", 400: "#a1a1aa", 500: "#71717a", 600: "#52525b", 700: "#3f3f46", 800: "#27272a", 900: "#18181b" };

export interface AccentScale {
  50: string;
  100: string;
  600: string;
  700: string;
}

export interface DesignTokens {
  accent: AccentScale;
  neutral: NeutralScale;
  /** Google Font family for HEADINGS (the single biggest "premium" lever). */
  displayFont: string;
  /** Google Font family for body text. */
  bodyFont: string;
  /** Whether headings render in the display font (true) — usually an elegant serif. */
  serifHeadings: boolean;
  /** Base corner radius for cards/inputs, e.g. "0.75rem". */
  radius: string;
}

export interface DesignPreset {
  key: string;
  name: string; // shown in the picker
  tagline: string; // one-line description for the picker
  tokens: DesignTokens; // the concrete, scaffolded design language
  /** Prose injected into codegen so the model styles WITH the scaffolded system (not against it). */
  instructions: string;
}

export const DESIGN_PRESETS: DesignPreset[] = [
  {
    // DEFAULT — premium, not bland. Editorial serif headings + a refined indigo on cool-neutral.
    key: "clean",
    name: "Clean & minimal",
    tagline: "Editorial whitespace, elegant serif headings, one refined accent — premium default.",
    tokens: { accent: { 50: "#eef2ff", 100: "#e0e7ff", 600: "#4f46e5", 700: "#4338ca" }, neutral: SLATE, displayFont: "Fraunces", bodyFont: "Inter", serifHeadings: true, radius: "0.75rem" },
    instructions:
      "Editorial minimalism: lots of whitespace, an elegant SERIF for headings (Fraunces) over a clean sans body (Inter), and ONE refined indigo accent used sparingly for primary actions. Soft cards with subtle borders and a gentle shadow. Calm, confident, premium — Linear/Stripe-docs elevated with a serif voice.",
  },
  {
    key: "warm",
    name: "Warm & friendly",
    tagline: "Warm stone + dusty rose, serif headings, soft cards — approachable and human.",
    tokens: { accent: { 50: "#fdf3f5", 100: "#f9e5ea", 600: "#b1495f", 700: "#973c4f" }, neutral: STONE, displayFont: "Fraunces", bodyFont: "Inter", serifHeadings: true, radius: "0.875rem" },
    instructions:
      "Warm and inviting: a warm stone neutral, a dusty-rose accent, an elegant serif for headings (Fraunces), generous padding, larger radii and soft shadows. Approachable and human, never corporate — good for childcare, community, wellness, hospitality.",
  },
  {
    key: "bold",
    name: "Bold & modern",
    tagline: "High-contrast, vivid violet, big tight sans display — for products that stand out.",
    tokens: { accent: { 50: "#f5f3ff", 100: "#ede9fe", 600: "#7c3aed", 700: "#6d28d9" }, neutral: ZINC, displayFont: "Space Grotesk", bodyFont: "Inter", serifHeadings: false, radius: "0.625rem" },
    instructions:
      "High-contrast and confident: large tight display headings in a modern grotesk (Space Grotesk), a vivid violet accent, near-black neutrals with crisp light surfaces, generous section spacing and energetic buttons. Vercel/Framer energy.",
  },
  {
    key: "professional",
    name: "Professional",
    tagline: "Navy on slate, serif headings, dense and credible — finance, legal, healthcare.",
    tokens: { accent: { 50: "#eef2f7", 100: "#d9e2ec", 600: "#1e3a5f", 700: "#16293f" }, neutral: SLATE, displayFont: "Fraunces", bodyFont: "Inter", serifHeadings: true, radius: "0.5rem" },
    instructions:
      "Conservative and trustworthy: a restrained navy accent on slate neutrals, a serif-for-headings pairing, dense information-forward layouts, clear tables, square-ish cards, strong alignment. Credible to a regulated-industry buyer — a polished bank/legal dashboard.",
  },
];

const DEFAULT_PRESET = "clean";

export function designPreset(key: string | undefined): DesignPreset {
  return DESIGN_PRESETS.find((p) => p.key === key) ?? DESIGN_PRESETS.find((p) => p.key === DEFAULT_PRESET)!;
}

/** The design-direction block appended to the codegen system prompt. Tells the model a premium
 *  design system is ALREADY SCAFFOLDED (theme + globals.css + component classes) and to build WITH
 *  it — so the model's utility classes resolve through the themed tokens instead of fighting them. */
export function designBlock(presetKey: string | undefined = process.env.VIBEHARD_DESIGN): string {
  const p = designPreset(presetKey);
  return `

DESIGN SYSTEM — "${p.name}" (already scaffolded into the app; build WITH it, don't reinvent it):
${p.instructions}
A premium theme is pre-written for you: tailwind.config.ts carries the accent color + a warm/cool neutral remapped onto \`slate-*\` + the fonts, and globals.css defines the design tokens, ${p.tokens.serifHeadings ? "SERIF display headings (h1/h2/h3 use the display font automatically)" : "a bold display font for headings"}, and component classes: \`.btn\`/\`.btn-primary\`/\`.btn-secondary\`, \`.card\`, \`.input\`, \`.label\`, \`.chip\`. USE THESE — primary actions get \`.btn .btn-primary\` (or \`bg-accent text-white\`), surfaces get \`.card\`, form fields get \`.input\`/\`.label\`, status pills get \`.chip\`. Do NOT introduce a different palette, import other fonts, or hand-roll button/card styles — the system already covers it. Keep using \`slate-*\` utility classes for neutrals (they resolve to the themed neutral).

Baseline (always): consistent spacing, clear hierarchy, WCAG-AA contrast, responsive/mobile, and real empty/loading/error states. It must look like a designer set it up.`;
}
