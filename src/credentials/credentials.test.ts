import { describe, expect, test } from "bun:test";
import { collectAppEnv, parseEnvExampleKeys, requiredCredentials } from "./credentials.ts";

const ENV_EXAMPLE = `# Supabase (provided automatically)
SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
PORT=8080

# Payments
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx

# Auth
GOOGLE_CLIENT_ID=your-id
GOOGLE_CLIENT_SECRET=your-secret

# Email + a service we don't know
RESEND_API_KEY=your-key
ACME_API_KEY=your-acme-key
`;

describe("parseEnvExampleKeys", () => {
  test("extracts var names, ignoring comments + blanks", () => {
    expect(parseEnvExampleKeys(ENV_EXAMPLE)).toEqual([
      "SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "PORT",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "RESEND_API_KEY",
      "ACME_API_KEY",
    ]);
  });
});

describe("requiredCredentials", () => {
  const req = requiredCredentials(ENV_EXAMPLE);
  test("subtracts the auto-provided Supabase/PORT vars", () => {
    const keys = req.map((c) => c.key);
    expect(keys).not.toContain("SUPABASE_URL");
    expect(keys).not.toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    expect(keys).not.toContain("PORT");
  });
  test("keeps + classifies the third-party keys", () => {
    const byKey = Object.fromEntries(req.map((c) => [c.key, c]));
    expect(byKey.STRIPE_SECRET_KEY!.label).toBe("Stripe secret key");
    expect(byKey.STRIPE_SECRET_KEY!.help).toContain("dashboard.stripe.com");
    expect(byKey.GOOGLE_CLIENT_ID!.label).toContain("Google sign-in");
    expect(byKey.RESEND_API_KEY!.label).toContain("Resend");
  });
  test("classifies an UNKNOWN key with a sensible label, never drops it", () => {
    const acme = req.find((c) => c.key === "ACME_API_KEY");
    expect(acme).toBeTruthy();
    expect(acme!.label).toBe("Acme API key");
  });
});

describe("collectAppEnv", () => {
  const req = requiredCredentials(ENV_EXAMPLE);
  test("collects only the provided (non-blank) values for required keys", () => {
    const out = collectAppEnv(req, { STRIPE_SECRET_KEY: "sk_live_real", RESEND_API_KEY: "  ", GOOGLE_CLIENT_ID: "id123", SUPABASE_URL: "should-be-ignored" });
    expect(out).toEqual({ STRIPE_SECRET_KEY: "sk_live_real", GOOGLE_CLIENT_ID: "id123" });
  });
});
