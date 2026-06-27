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

  test("C-4 (audit2): a platform/operator token is NEVER injected even if the app declares it", () => {
    // a generated (or adversarial) app whose .env.example names operator-only infra tokens
    const req2 = requiredCredentials("FLY_API_TOKEN=\nVERCEL_TOKEN=\nVIBEHARD_SECRETS_KEY=\nGITHUB_WEBHOOK_SECRET=\nSTRIPE_SECRET_KEY=\nMY_APP_KEY=");
    const out = collectAppEnv(req2, {
      FLY_API_TOKEN: "operator-fly-token",
      VERCEL_TOKEN: "operator-vercel-token",
      VIBEHARD_SECRETS_KEY: "operator-master-key",
      GITHUB_WEBHOOK_SECRET: "operator-webhook-secret",
      STRIPE_SECRET_KEY: "tenant-own-stripe", // legitimately tenant-supplied → still injected
      MY_APP_KEY: "app-value",
    });
    expect(out.FLY_API_TOKEN).toBeUndefined();
    expect(out.VERCEL_TOKEN).toBeUndefined();
    expect(out.VIBEHARD_SECRETS_KEY).toBeUndefined();
    expect(out.GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(out.STRIPE_SECRET_KEY).toBe("tenant-own-stripe"); // not platform-infra → allowed
    expect(out.MY_APP_KEY).toBe("app-value");
  });
});
