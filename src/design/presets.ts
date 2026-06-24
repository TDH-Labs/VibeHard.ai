/**
 * Design presets (backlog #12). VibeHard's codegen used to emit whatever the base model defaulted
 * to — no visual direction. For a NON-TECHNICAL audience that wants a good-looking app, design can't
 * be "ask the model to make it pretty"; it has to be DIRECTED. Each preset is a concrete, opinionated
 * design language (palette, type, spacing, component style) the user picks; its instructions are
 * injected into the codegen prompt so every screen inherits a consistent, professional look. A
 * later art-director pass (refine-llm) polishes on top.
 *
 * Pure: `designBlock()` reads the chosen preset (VIBEHARD_DESIGN env) and returns the prompt block.
 */
export interface DesignPreset {
  key: string;
  name: string; // shown in the picker
  tagline: string; // one-line description for the picker
  /** The design language injected into codegen — concrete enough to produce a consistent look. */
  instructions: string;
}

export const DESIGN_PRESETS: DesignPreset[] = [
  {
    key: "clean",
    name: "Clean & minimal",
    tagline: "Lots of whitespace, neutral palette, one accent — the safe, modern default.",
    instructions:
      "Neutral palette (white / slate grays) with ONE accent color (a calm blue or teal) used sparingly for primary actions. Generous whitespace, a clear type scale (large bold headings, comfortable body), the Inter font (or system sans). Simple flat cards with subtle 1px borders and small radii; understated. Think Linear / Stripe docs.",
  },
  {
    key: "warm",
    name: "Warm & friendly",
    tagline: "Soft warm colors, rounded, approachable — good for consumer & community apps.",
    instructions:
      "Warm, inviting palette (cream / soft amber / coral accents). Rounded corners (larger radii), soft shadows, a friendly rounded sans (Nunito / Poppins feel). Generous padding, gentle gradients allowed, large friendly buttons. Approachable and human, never corporate. Think Airbnb / Duolingo warmth.",
  },
  {
    key: "bold",
    name: "Bold & modern",
    tagline: "High contrast, vivid accent, big type — for products that want to stand out.",
    instructions:
      "High-contrast, confident design: large display headings, a vivid accent color (electric blue / violet / lime), strong dark sections alternating with light. Big type scale, tight headings, generous section spacing, crisp buttons with clear states. Modern and energetic. Think Vercel / Framer landing pages.",
  },
  {
    key: "professional",
    name: "Professional",
    tagline: "Navy & gray, conservative, trustworthy — for finance, legal, healthcare.",
    instructions:
      "Conservative, trustworthy palette (navy / slate / white, a restrained accent). Classic, dense, information-forward layouts; a clean grotesk or serif-for-headings pairing. Square-ish cards, clear tables, muted colors, strong alignment. Looks credible to a regulated-industry buyer. Think a polished bank or legal dashboard.",
  },
];

const DEFAULT_PRESET = "clean";

export function designPreset(key: string | undefined): DesignPreset {
  return DESIGN_PRESETS.find((p) => p.key === key) ?? DESIGN_PRESETS.find((p) => p.key === DEFAULT_PRESET)!;
}

/** The design-direction block to append to the codegen system prompt. Reads VIBEHARD_DESIGN (the
 *  user's chosen preset) and always includes a baseline "make it look professionally designed" bar. */
export function designBlock(presetKey: string | undefined = process.env.VIBEHARD_DESIGN): string {
  const p = designPreset(presetKey);
  return `

DESIGN DIRECTION — "${p.name}". Apply this look consistently across EVERY screen:
${p.instructions}

Baseline (always): a consistent spacing scale, clear visual hierarchy, accessible color contrast (WCAG AA), a responsive layout that works on mobile, and polished components (buttons, inputs, cards, empty states, loading states). Style with the stack's standard approach — Tailwind utility classes for a React/Next/Vite app, otherwise clean modern CSS. Do NOT ship an unstyled or default-looking page; it should look like a designer set it up.`;
}
