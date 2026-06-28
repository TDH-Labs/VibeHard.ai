import { describe, expect, test } from "bun:test";
import { clerkConfig, frontendApiFromPublishableKey, resolveTenantForClerkUser, type ClerkTenantDeps } from "./clerk.ts";

describe("clerkConfig — enabled only when both keys present", () => {
  test("both keys → enabled", () => {
    expect(clerkConfig({ CLERK_SECRET_KEY: "sk_test_x", CLERK_PUBLISHABLE_KEY: "pk_test_y" })).toEqual({
      enabled: true,
      secretKey: "sk_test_x",
      publishableKey: "pk_test_y",
    });
  });
  test("missing either → disabled (legacy auth stays active)", () => {
    expect(clerkConfig({ CLERK_SECRET_KEY: "sk_test_x" }).enabled).toBe(false);
    expect(clerkConfig({ CLERK_PUBLISHABLE_KEY: "pk_test_y" }).enabled).toBe(false);
    expect(clerkConfig({}).enabled).toBe(false);
  });
});

describe("frontendApiFromPublishableKey", () => {
  test("derives the Frontend API host from the base64 segment (trailing $ stripped)", () => {
    const host = "clerk.bold-frog-12.lcl.dev";
    const pk = `pk_test_${btoa(`${host}$`)}`;
    expect(frontendApiFromPublishableKey(pk)).toBe(host);
  });
  test("malformed key → null (no crash)", () => {
    expect(frontendApiFromPublishableKey("not-a-key")).toBeNull();
    expect(frontendApiFromPublishableKey("pk_test_!!!notbase64")).toBeNull();
  });
});

describe("resolveTenantForClerkUser — account continuity + first-seen creation", () => {
  const base = (over: Partial<ClerkTenantDeps> = {}): ClerkTenantDeps => ({
    getEmail: async () => "User@Example.com",
    findTenantByEmail: () => null,
    createTenant: () => "t-new",
    getName: async () => "Ada",
    ...over,
  });

  test("first-seen Clerk user → creates a tenant (email normalized lowercase)", async () => {
    const created: Array<{ email: string; name: string; userId: string }> = [];
    const r = await resolveTenantForClerkUser("user_1", base({
      createTenant: (email, name, userId) => {
        created.push({ email, name, userId });
        return "t-created";
      },
    }));
    expect(r).toEqual({ email: "user@example.com", tenantId: "t-created" });
    expect(created[0]).toEqual({ email: "user@example.com", name: "Ada", userId: "user_1" });
  });

  test("existing account for that verified email → reused, NOT recreated (cutover continuity)", async () => {
    let createCalls = 0;
    const r = await resolveTenantForClerkUser("user_1", base({
      findTenantByEmail: (email) => (email === "user@example.com" ? "t-existing" : null),
      createTenant: () => {
        createCalls++;
        return "t-should-not-happen";
      },
    }));
    expect(r?.tenantId).toBe("t-existing");
    expect(createCalls).toBe(0);
  });

  test("no resolvable email → null (never a half-made account)", async () => {
    const r = await resolveTenantForClerkUser("user_1", base({ getEmail: async () => null }));
    expect(r).toBeNull();
  });

  test("falls back to email local-part when no display name", async () => {
    let name = "";
    await resolveTenantForClerkUser("user_1", base({
      getName: async () => null,
      createTenant: (_e, n) => {
        name = n;
        return "t";
      },
    }));
    expect(name).toBe("user");
  });
});
