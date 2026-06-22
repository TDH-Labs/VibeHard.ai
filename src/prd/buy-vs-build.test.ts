import { describe, expect, test } from "bun:test";
import { buyVsBuild } from "./buy-vs-build.ts";
import type { Spec } from "../spec/index.ts";

function spec(over: Partial<Spec> = {}): Spec {
  return {
    name: "app",
    summary: "",
    features: [],
    users: "",
    tenancy: "single-user",
    auth: "none",
    storesData: false,
    dataEntities: [],
    sensitiveData: ["none"],
    realUsers: false,
    maintained: false,
    ...over,
  };
}

describe("buyVsBuild (advisory registry — §22)", () => {
  test("a payments need → BUY Stripe (don't let a non-technical user rebuild it)", () => {
    const advs = buyVsBuild(spec({ summary: "an online store with checkout and subscription billing" }));
    const pay = advs.find((a) => a.category === "payments");
    expect(pay).toMatchObject({ recommendation: "buy", service: "Stripe" });
    expect(pay!.rationale).toMatch(/default stays build|you decide/i); // advisory, never auto-procure
  });

  test("auth + email needs → BUY both categories", () => {
    const cats = buyVsBuild(spec({ summary: "users sign in and get email notifications", features: ["login", "send email"] })).map((a) => a.category);
    expect(cats).toContain("authentication");
    expect(cats).toContain("email & notifications");
  });

  test("a plain offline tool → no advisories (nothing to buy)", () => {
    expect(buyVsBuild(spec({ summary: "convert metric and imperial units", features: ["convert length"] }))).toEqual([]);
  });

  test("the auth field itself signals authentication", () => {
    expect(buyVsBuild(spec({ auth: "oauth", features: ["view dashboard"] })).map((a) => a.category)).toContain("authentication");
  });
});
