import { describe, expect, test } from "bun:test";
import { coercePrd, extractJsonObject, parsePrd } from "./coerce.ts";

describe("coercePrd — the trust boundary (untrusted JSON → valid Prd)", () => {
  test("a well-formed object is preserved", () => {
    const p = coercePrd({
      name: "clinic",
      summary: "books appts",
      features: ["add patient"],
      users: "staff",
      tenancy: "multi-tenant",
      auth: "email-password",
      storesData: true,
      dataEntities: [{ name: "patients", fields: ["id", "name"], sensitive: true }],
      sensitiveData: ["phi"],
      realUsers: true,
      maintained: true,
    });
    expect(p).toMatchObject({ name: "clinic", tenancy: "multi-tenant", auth: "email-password", storesData: true });
    expect(p.dataEntities[0]).toEqual({ name: "patients", fields: ["id", "name"], sensitive: true });
  });

  test("garbage / empty → safe conservative defaults (not a falsely-safe spec)", () => {
    for (const junk of [null, undefined, 42, "nope", []]) {
      const p = coercePrd(junk);
      expect(p.name).toBe("untitled-app");
      expect(p.tenancy).toBe("single-user");
      expect(p.auth).toBe("none"); // omitted auth defaults to none → reviewPrd flags it for sensitive apps
      expect(p.features).toEqual([]);
      expect(p.sensitiveData).toEqual(["none"]);
    }
  });

  test("invalid enums are clamped; non-string array members dropped", () => {
    const p = coercePrd({ tenancy: "galaxy", sensitiveData: ["pii", "nonsense", 7], features: ["ok", 5, null] });
    expect(p.tenancy).toBe("single-user"); // unknown tenancy → conservative default
    expect(p.sensitiveData).toEqual(["pii"]); // bad members filtered
    expect(p.features).toEqual(["ok"]); // non-strings dropped
  });

  test("malformed data entities are dropped (no name) and fields coerced", () => {
    const p = coercePrd({ dataEntities: [{ name: "notes", fields: ["id", 9] }, { fields: ["x"] }, "junk"] });
    expect(p.dataEntities).toEqual([{ name: "notes", fields: ["id"], sensitive: false }]);
  });

  test("storesData defaults to whether a data model is present", () => {
    expect(coercePrd({ dataEntities: [{ name: "t", fields: ["a"] }] }).storesData).toBe(true);
    expect(coercePrd({}).storesData).toBe(false);
  });
});

describe("extractJsonObject / parsePrd", () => {
  test("pulls JSON from a ```json fence", () => {
    const o = extractJsonObject('here you go:\n```json\n{"name":"x"}\n```\nthanks') as { name: string };
    expect(o.name).toBe("x");
  });

  test("pulls a bare object wrapped in prose", () => {
    expect((extractJsonObject('sure: {"name":"y"} done') as { name: string }).name).toBe("y");
  });

  test("throws when there is no object", () => {
    expect(() => extractJsonObject("no json here")).toThrow(/no JSON object/);
  });

  test("parsePrd extracts + coerces in one step", () => {
    const p = parsePrd('```json\n{"name":"z","tenancy":"multi-tenant","features":["f"]}\n```');
    expect(p).toMatchObject({ name: "z", tenancy: "multi-tenant", features: ["f"] });
  });
});
