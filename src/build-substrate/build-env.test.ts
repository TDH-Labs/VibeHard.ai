import { describe, expect, test } from "bun:test";
import { assembleBuildEnv } from "./build-env.ts";

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

  test("flyApiToken/vibehardSecretsKey/flyOrg/flyRegion are set only when explicitly provided (ship's deploy-time needs, SPEC decision #8)", () => {
    const empty = assembleBuildEnv({ byoKey: null, integrations: {}, integrationKeyNames: [] });
    expect(empty.FLY_API_TOKEN).toBeUndefined();
    expect(empty.VIBEHARD_SECRETS_KEY).toBeUndefined();
    expect(empty.FLY_ORG).toBeUndefined();
    expect(empty.FLY_REGION).toBeUndefined();

    const full = assembleBuildEnv({
      byoKey: null,
      integrations: {},
      integrationKeyNames: [],
      flyApiToken: "fo1_deploy-token",
      vibehardSecretsKey: "master-key-value",
      flyOrg: "personal",
      flyRegion: "iad",
    });
    expect(full.FLY_API_TOKEN).toBe("fo1_deploy-token");
    expect(full.VIBEHARD_SECRETS_KEY).toBe("master-key-value");
    expect(full.FLY_ORG).toBe("personal");
    expect(full.FLY_REGION).toBe("iad");
  });

  test("THE CONTRACT THIS CLOSES: the result never contains anything beyond the explicit allowlist — no ambient process.env leakage", () => {
    const env = assembleBuildEnv({
      byoKey: "sk-ant-abc",
      integrations: { STRIPE_SECRET_KEY: "sk_test_1" },
      integrationKeyNames: ["STRIPE_SECRET_KEY"],
      design: "brutalist",
      flyApiToken: "fo1_deploy-token",
      vibehardSecretsKey: "master-key-value",
    });
    const allowlist = new Set([
      "VIBEHARD_MANAGED",
      "VIBEHARD_TENANT_KEYS",
      "VIBEHARD_DESIGN",
      "ANTHROPIC_API_KEY",
      "STRIPE_SECRET_KEY",
      "FLY_API_TOKEN",
      "VIBEHARD_SECRETS_KEY",
    ]);
    for (const key of Object.keys(env)) expect(allowlist.has(key)).toBe(true);
    // and nothing UNEXPLAINED ever sneaks in, even if the test process's own env has it set —
    // every value present traces to an explicit BuildEnvParts field, not ambient process.env
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined(); // not passed as byoKey here, so absent
  });
});
