import { describe, expect, test } from "bun:test";
import { assembleBuildEnv, operatorLLMKey } from "./build-env.ts";

describe("operatorLLMKey — the fallback that closes the live 2026-07-11 bug (no-BYO-key tenants got NO LLM key at all)", () => {
  test("prefers OPENROUTER_API_KEY, matching providerOf()'s own priority order", () => {
    expect(operatorLLMKey({ OPENROUTER_API_KEY: "sk-or-x", OPENCODE_API_KEY: "oc-y", ANTHROPIC_API_KEY: "sk-ant-z" })).toBe("sk-or-x");
  });
  test("falls back to OPENCODE_API_KEY when no OpenRouter key", () => {
    expect(operatorLLMKey({ OPENCODE_API_KEY: "oc-y", ANTHROPIC_API_KEY: "sk-ant-z" })).toBe("oc-y");
  });
  test("falls back to ANTHROPIC_API_KEY when neither of the above is set", () => {
    expect(operatorLLMKey({ ANTHROPIC_API_KEY: "sk-ant-z" })).toBe("sk-ant-z");
  });
  test("undefined when none are set — the caller must handle a fully-unconfigured operator", () => {
    expect(operatorLLMKey({})).toBeUndefined();
  });
});

describe("assembleBuildEnv — SPEC decision #8 explicit allowlist", () => {
  test("no BYO key, no integrations, no design → only VIBEHARD_MANAGED + empty VIBEHARD_TENANT_KEYS", () => {
    const env = assembleBuildEnv({ byoKey: null, integrations: {}, integrationKeyNames: [] });
    expect(env).toEqual({ VIBEHARD_MANAGED: "1", VIBEHARD_TENANT_KEYS: "" });
  });

  test("an sk-ant- key sets ANTHROPIC_API_KEY, not the other two", () => {
    const env = assembleBuildEnv({ byoKey: "sk-ant-abc123", integrations: {}, integrationKeyNames: [] });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-abc123");
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.OPENCODE_API_KEY).toBeUndefined();
  });

  test("an sk-or- key sets OPENROUTER_API_KEY", () => {
    const env = assembleBuildEnv({ byoKey: "sk-or-xyz789", integrations: {}, integrationKeyNames: [] });
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-xyz789");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("any other prefix falls back to OPENCODE_API_KEY (the gateway-key catch-all)", () => {
    const env = assembleBuildEnv({ byoKey: "some-other-gateway-key", integrations: {}, integrationKeyNames: [] });
    expect(env.OPENCODE_API_KEY).toBe("some-other-gateway-key");
  });

  test("integrations are merged in verbatim", () => {
    const env = assembleBuildEnv({
      byoKey: null,
      integrations: { STRIPE_SECRET_KEY: "sk_test_1", RESEND_API_KEY: "re_1" },
      integrationKeyNames: ["STRIPE_SECRET_KEY", "RESEND_API_KEY"],
    });
    expect(env.STRIPE_SECRET_KEY).toBe("sk_test_1");
    expect(env.RESEND_API_KEY).toBe("re_1");
    expect(env.VIBEHARD_TENANT_KEYS).toBe("STRIPE_SECRET_KEY,RESEND_API_KEY");
  });

  test("design is set only when provided", () => {
    expect(assembleBuildEnv({ byoKey: null, integrations: {}, integrationKeyNames: [] }).VIBEHARD_DESIGN).toBeUndefined();
    expect(assembleBuildEnv({ byoKey: null, integrations: {}, integrationKeyNames: [], design: "brutalist" }).VIBEHARD_DESIGN).toBe(
      "brutalist",
    );
  });

  test("flyApiToken/vibehardSecretsKey/flyOrg/flyRegion/supabaseManagementToken are set only when explicitly provided (ship's deploy-time needs, SPEC decision #8)", () => {
    const empty = assembleBuildEnv({ byoKey: null, integrations: {}, integrationKeyNames: [] });
    expect(empty.FLY_API_TOKEN).toBeUndefined();
    expect(empty.VIBEHARD_SECRETS_KEY).toBeUndefined();
    expect(empty.FLY_ORG).toBeUndefined();
    expect(empty.FLY_REGION).toBeUndefined();
    expect(empty.SUPABASE_ACCESS_TOKEN).toBeUndefined();

    const full = assembleBuildEnv({
      byoKey: null,
      integrations: {},
      integrationKeyNames: [],
      flyApiToken: "fo1_deploy-token",
      vibehardSecretsKey: "master-key-value",
      flyOrg: "personal",
      flyRegion: "iad",
      supabaseManagementToken: "sbp_management-token",
    });
    expect(full.FLY_API_TOKEN).toBe("fo1_deploy-token");
    expect(full.VIBEHARD_SECRETS_KEY).toBe("master-key-value");
    expect(full.FLY_ORG).toBe("personal");
    expect(full.FLY_REGION).toBe("iad");
    expect(full.SUPABASE_ACCESS_TOKEN).toBe("sbp_management-token");
  });

  test("THE BUG THIS CLOSES: every sandboxed build runs VIBEHARD_MANAGED=1 unconditionally, so a ship with no supabaseManagementToken WOULD die inside the sandbox exactly as it did live 2026-07-19 — 'missing SUPABASE_ACCESS_TOKEN (or SUPABASE_PAT)' — even though the platform HOST had SUPABASE_PAT set; nothing forwarded it. This just proves VIBEHARD_MANAGED really is unconditional — the actual forwarding is proven by the test above.", () => {
    const env = assembleBuildEnv({ byoKey: null, integrations: {}, integrationKeyNames: [] });
    expect(env.VIBEHARD_MANAGED).toBe("1");
    expect(env.SUPABASE_ACCESS_TOKEN).toBeUndefined();
  });

  test("THE CONTRACT THIS CLOSES: the result never contains anything beyond the explicit allowlist — no ambient process.env leakage", () => {
    const env = assembleBuildEnv({
      byoKey: "sk-ant-abc",
      integrations: { STRIPE_SECRET_KEY: "sk_test_1" },
      integrationKeyNames: ["STRIPE_SECRET_KEY"],
      design: "brutalist",
      flyApiToken: "fo1_deploy-token",
      vibehardSecretsKey: "master-key-value",
      supabaseManagementToken: "sbp_management-token",
    });
    const allowlist = new Set([
      "VIBEHARD_MANAGED",
      "VIBEHARD_TENANT_KEYS",
      "VIBEHARD_DESIGN",
      "ANTHROPIC_API_KEY",
      "STRIPE_SECRET_KEY",
      "FLY_API_TOKEN",
      "VIBEHARD_SECRETS_KEY",
      "SUPABASE_ACCESS_TOKEN",
    ]);
    for (const key of Object.keys(env)) expect(allowlist.has(key)).toBe(true);
    // and nothing UNEXPLAINED ever sneaks in, even if the test process's own env has it set —
    // every value present traces to an explicit BuildEnvParts field, not ambient process.env
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined(); // not passed as byoKey here, so absent
  });
});
