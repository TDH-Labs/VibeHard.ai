/**
 * External-credential detection (backlog #5). An app the builder requests often needs third-party
 * keys — Stripe, Google/GitHub OAuth, an email provider. The codegen prompt makes every app declare
 * what it reads from the environment in a `.env.example`, so that file IS the authoritative manifest
 * of what the app needs. We subtract the vars VibeHard provisions automatically (Supabase, PORT, …)
 * and classify the rest into a plain-language checklist the user can fill in — then those values are
 * injected at deploy (so an app that reads STRIPE_SECRET_KEY doesn't ship with it undefined).
 *
 * Pure + deterministic: parse → subtract → classify. No I/O except the dir convenience reader.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Vars VibeHard injects itself (Supabase substrate + platform) — never ask the user for these. */
const AUTO_PROVIDED = new Set<string>([
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_JWT_SECRET",
  "SUPABASE_DB_URL",
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_DB_HOST",
  "SUPABASE_DB_PORT",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "DATABASE_URL",
  "PORT",
  "NODE_ENV",
  "HOST",
]);

export interface RequiredCredential {
  key: string; // the env var name the app reads
  label: string; // plain-language name ("Stripe secret key")
  help: string; // where to get it
}

/** Known services → friendly label + where to find the key. */
const DICT: Record<string, { label: string; help: string }> = {
  STRIPE_SECRET_KEY: { label: "Stripe secret key", help: "dashboard.stripe.com → Developers → API keys (starts with sk_)" },
  STRIPE_PUBLISHABLE_KEY: { label: "Stripe publishable key", help: "dashboard.stripe.com → Developers → API keys (starts with pk_)" },
  STRIPE_WEBHOOK_SECRET: { label: "Stripe webhook signing secret", help: "dashboard.stripe.com → Developers → Webhooks (starts with whsec_)" },
  GOOGLE_CLIENT_ID: { label: "Google sign-in — client ID", help: "console.cloud.google.com → APIs & Services → Credentials → OAuth client" },
  GOOGLE_CLIENT_SECRET: { label: "Google sign-in — client secret", help: "console.cloud.google.com → APIs & Services → Credentials → OAuth client" },
  GITHUB_CLIENT_ID: { label: "GitHub sign-in — client ID", help: "github.com → Settings → Developer settings → OAuth Apps" },
  GITHUB_CLIENT_SECRET: { label: "GitHub sign-in — client secret", help: "github.com → Settings → Developer settings → OAuth Apps" },
  RESEND_API_KEY: { label: "Resend API key (email)", help: "resend.com → API Keys" },
  SENDGRID_API_KEY: { label: "SendGrid API key (email)", help: "app.sendgrid.com → Settings → API Keys" },
  POSTMARK_API_TOKEN: { label: "Postmark server token (email)", help: "postmarkapp.com → Servers → API Tokens" },
  TWILIO_ACCOUNT_SID: { label: "Twilio Account SID (SMS)", help: "console.twilio.com → Account Info" },
  TWILIO_AUTH_TOKEN: { label: "Twilio auth token (SMS)", help: "console.twilio.com → Account Info" },
  OPENAI_API_KEY: { label: "OpenAI API key", help: "platform.openai.com → API keys" },
  ANTHROPIC_API_KEY: { label: "Anthropic API key", help: "console.anthropic.com → API keys" },
  CLERK_SECRET_KEY: { label: "Clerk secret key (auth)", help: "dashboard.clerk.com → API Keys" },
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: { label: "Clerk publishable key (auth)", help: "dashboard.clerk.com → API Keys" },
};

/** Best-effort plain-language label for an unknown env var (e.g. ACME_API_KEY → "Acme API key"). */
function classify(key: string): { label: string; help: string } {
  if (DICT[key]) return DICT[key]!;
  const service = key
    .replace(/^(NEXT_PUBLIC_|VITE_)/, "")
    .replace(/_(API_)?KEY$|_SECRET(_KEY)?$|_TOKEN$|_CLIENT_(ID|SECRET)$|_SID$/i, "")
    .replace(/_/g, " ")
    .trim();
  const pretty = service ? service.charAt(0).toUpperCase() + service.slice(1).toLowerCase() : key;
  const kind = /SECRET/i.test(key) ? "secret" : /TOKEN/i.test(key) ? "token" : /KEY/i.test(key) ? "API key" : /CLIENT_ID/i.test(key) ? "client ID" : "value";
  return { label: `${pretty} ${kind}`.trim(), help: `Required by your app — get this from ${pretty}.` };
}

/** Parse the declared env var NAMES from a .env.example (ignores comments + blank lines). */
export function parseEnvExampleKeys(content: string): string[] {
  const keys: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=/);
    if (m && !keys.includes(m[1]!)) keys.push(m[1]!);
  }
  return keys;
}

/** The credentials the USER must supply: declared in .env.example, minus what VibeHard auto-provides. */
export function requiredCredentials(envExample: string): RequiredCredential[] {
  return parseEnvExampleKeys(envExample)
    .filter((k) => !AUTO_PROVIDED.has(k))
    .map((k) => ({ key: k, ...classify(k) }));
}

const ENV_EXAMPLE_NAMES = [".env.example", ".env.sample", ".env.template"];

/** Read an app dir's .env.example and return the required user credentials (empty if none). */
export function requiredCredentialsForApp(dir: string): RequiredCredential[] {
  for (const name of ENV_EXAMPLE_NAMES) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try {
        return requiredCredentials(readFileSync(p, "utf8"));
      } catch {
        return [];
      }
    }
  }
  return [];
}

/** Collect the values the user actually provided for the required keys, from a source (e.g.
 *  process.env). Blank/missing values are skipped, so a half-filled set injects only what's set. */
export function collectAppEnv(required: RequiredCredential[], source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of required) {
    const v = source[c.key];
    if (v && v.trim()) out[c.key] = v;
  }
  return out;
}
