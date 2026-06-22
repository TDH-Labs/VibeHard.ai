import { describe, expect, test } from "bun:test";
import { coerceSpec, extractJsonObject, parseSpec, tryExtractJsonObject } from "./coerce.ts";

describe("tryExtractJsonObject — resilient extractor (never throws)", () => {
  test("returns the object on good input, null on missing/invalid JSON", () => {
    expect(tryExtractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(tryExtractJsonObject("no json here")).toBeNull(); // would-throw → null
    expect(tryExtractJsonObject("{ broken")).toBeNull(); // unparseable → null
  });

  test("coerce* turn a null (bad response) into a safe degenerate artifact, not a crash", () => {
    // This is the contract the resilient LLM stages rely on.
    expect(coerceSpec(tryExtractJsonObject("garbage")).features).toEqual([]);
  });
});

describe("coerceSpec — the trust boundary (untrusted JSON → valid Spec)", () => {
  test("a well-formed object is preserved", () => {
    const p = coerceSpec({
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
      const p = coerceSpec(junk);
      expect(p.name).toBe("untitled-app");
      expect(p.tenancy).toBe("single-user");
      expect(p.auth).toBe("none"); // omitted auth defaults to none → reviewSpec flags it for sensitive apps
      expect(p.features).toEqual([]);
      expect(p.sensitiveData).toEqual(["none"]);
    }
  });

  test("invalid enums are clamped; non-string array members dropped", () => {
    const p = coerceSpec({ tenancy: "galaxy", sensitiveData: ["pii", "nonsense", 7], features: ["ok", 5, null] });
    expect(p.tenancy).toBe("single-user"); // unknown tenancy → conservative default
    expect(p.sensitiveData).toEqual(["pii"]); // bad members filtered
    expect(p.features).toEqual(["ok"]); // non-strings dropped
  });

  test("malformed data entities are dropped (no name) and fields coerced", () => {
    const p = coerceSpec({ dataEntities: [{ name: "notes", fields: ["id", 9] }, { fields: ["x"] }, "junk"] });
    expect(p.dataEntities).toEqual([{ name: "notes", fields: ["id"], sensitive: false }]);
  });

  test("storesData defaults to whether a data model is present", () => {
    expect(coerceSpec({ dataEntities: [{ name: "t", fields: ["a"] }] }).storesData).toBe(true);
    expect(coerceSpec({}).storesData).toBe(false);
  });
});

describe("extractJsonObject / parseSpec", () => {
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

  test("parseSpec extracts + coerces in one step", () => {
    const p = parseSpec('```json\n{"name":"z","tenancy":"multi-tenant","features":["f"]}\n```');
    expect(p).toMatchObject({ name: "z", tenancy: "multi-tenant", features: ["f"] });
  });
});
