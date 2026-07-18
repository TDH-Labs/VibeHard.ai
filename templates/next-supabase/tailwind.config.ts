import type { Config } from "tailwindcss";

// Baseline Tailwind config — the design-system scaffold (scaffoldDesignSystem) overwrites this
// with the chosen preset's theme during a build; this version keeps the template building green
// standalone (CI proves it).
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}", "./pages/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
