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

  test("THE CONTRACT THIS CLOSES: the result never contains anything beyond the explicit allowlist — no ambient process.env leakage", () => {
    const env = assembleBuildEnv({
      byoKey: "sk-ant-abc",
      integrations: { STRIPE_SECRET_KEY: "sk_test_1" },
      integrationKeyNames: ["STRIPE_SECRET_KEY"],
      design: "brutalist",
    });
    const allowlist = new Set(["VIBEHARD_MANAGED", "VIBEHARD_TENANT_KEYS", "VIBEHARD_DESIGN", "ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY"]);
    for (const key of Object.keys(env)) expect(allowlist.has(key)).toBe(true);
    // and nothing operator-only ever sneaks in, even if the test process's own env has it set
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.FLY_API_TOKEN).toBeUndefined();
  });
});
