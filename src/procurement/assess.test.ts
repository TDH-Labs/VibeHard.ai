import { describe, expect, test } from "bun:test";
import { assess, assessSafety, categorizeLicense, decideDisposition, fallbackRationale, rank, scoreCandidate } from "./assess.ts";
import type { Candidate, Capability, Evidence } from "./types.ts";

const ev = (over: Partial<Evidence> = {}): Evidence => ({
  license: "MIT",
  licenseCategory: "permissive",
  lastReleaseISO: "2026-06-01",
  ageDays: 20,
  deprecated: false,
  archived: false,
  advisories: 0,
  scorecard: 7,
  adoption: 500,
  ...over,
});
const pkg = (name = "pkg", over: Partial<Candidate> = {}): Candidate => ({ kind: "package", name, source: "npm-search", ecosystem: "npm", ...over });
const svc = (name = "Stripe"): Candidate => ({ kind: "service", name, source: "registry" });
const cap = (over: Partial<Capability> = {}): Capability => ({ key: "payments", need: "n", searchTerms: ["payments"], knownServices: ["Stripe"], ...over });

describe("categorizeLicense — the embed-safety axis", () => {
  test("permissive families", () => {
    for (const l of ["MIT", "ISC", "Apache-2.0", "BSD-3-Clause", "0BSD", "Unlicense", "CC0-1.0"]) expect(categorizeLicense(l)).toBe("permissive");
  });
  test("strong-copyleft is caught (and not confused with LGPL)", () => {
    expect(categorizeLicense("GPL-3.0")).toBe("strong-copyleft");
    expect(categorizeLicense("AGPL-3.0")).toBe("strong-copyleft");
    expect(categorizeLicense("SSPL-1.0")).toBe("strong-copyleft");
    expect(categorizeLicense("LGPL-3.0")).toBe("weak-copyleft"); // not a false strong-copyleft
  });
  test("weak-copyleft + proprietary + unknown", () => {
    expect(categorizeLicense("MPL-2.0")).toBe("weak-copyleft");
    expect(categorizeLicense("UNLICENSED")).toBe("proprietary"); // npm's no-license marker
    expect(categorizeLicense(null)).toBe("unknown");
    expect(categorizeLicense("")).toBe("unknown");
    expect(categorizeLicense("Frobnicate-1.0")).toBe("unknown");
  });
});

describe("assessSafety — the hard filter (fail-closed)", () => {
  test("a clean permissive recent package is safe with no blockers", () => {
    const v = assessSafety(ev());
    expect(v.safe).toBe(true);
    expect(v.blockers).toEqual([]);
  });
  test("no evidence → unsafe (unverifiable is not a safe default)", () => {
    const v = assessSafety(null);
    expect(v.safe).toBe(false);
    expect(v.blockers[0]).toMatch(/could not verify/i);
  });
  test("known advisories block", () => {
    expect(assessSafety(ev({ advisories: 2 })).blockers.join(" ")).toMatch(/2 known security advisories/);
    expect(assessSafety(ev({ advisories: 2 })).safe).toBe(false);
  });
  test("strong-copyleft and proprietary licenses block", () => {
    expect(assessSafety(ev({ license: "GPL-3.0", licenseCategory: "strong-copyleft" })).safe).toBe(false);
    expect(assessSafety(ev({ license: "UNLICENSED", licenseCategory: "proprietary" })).safe).toBe(false);
  });
  test("archived / deprecated block", () => {
    expect(assessSafety(ev({ archived: true })).safe).toBe(false);
    expect(assessSafety(ev({ deprecated: true })).safe).toBe(false);
  });
  test("staleness, low scorecard, weak-copyleft, unknown license → warn, not block", () => {
    expect(assessSafety(ev({ ageDays: 700 }))).toMatchObject({ safe: true });
    expect(assessSafety(ev({ ageDays: 700 })).warnings.join(" ")).toMatch(/unmaintained/);
    expect(assessSafety(ev({ scorecard: 2 })).warnings.join(" ")).toMatch(/Scorecard/);
    expect(assessSafety(ev({ license: "LGPL-3.0", licenseCategory: "weak-copyleft" })).warnings.join(" ")).toMatch(/weak-copyleft/);
    expect(assessSafety(ev({ license: null, licenseCategory: "unknown" })).warnings.join(" ")).toMatch(/license could not be determined/);
  });
});

describe("scoreCandidate", () => {
  test("unsafe candidates score 0", () => {
    const bad = ev({ advisories: 1 });
    expect(scoreCandidate(bad, assessSafety(bad))).toBe(0);
    expect(scoreCandidate(null, assessSafety(null))).toBe(0);
  });
  test("a healthy popular permissive package scores well and beats a weak one", () => {
    const good = ev();
    const weak = ev({ ageDays: 900, adoption: 5, scorecard: 3, license: "MPL-2.0", licenseCategory: "weak-copyleft" });
    expect(scoreCandidate(good, assessSafety(good))).toBeGreaterThan(70);
    expect(scoreCandidate(good, assessSafety(good))).toBeGreaterThan(scoreCandidate(weak, assessSafety(weak)));
  });
});

describe("assess — services are curated, packages are vetted", () => {
  test("a service is trusted-safe with a fixed baseline and an operator caveat", () => {
    const a = assess(svc("Stripe"), null);
    expect(a.safety.safe).toBe(true);
    expect(a.score).toBe(70);
    expect(a.evidence).toBeNull();
    expect(a.safety.warnings.join(" ")).toMatch(/pricing|compliance|data-residency/);
  });
  test("a clean package passes; a vulnerable one is unsafe and scores 0", () => {
    expect(assess(pkg("good"), ev()).safety.safe).toBe(true);
    expect(assess(pkg("bad"), ev({ advisories: 1 })).safety.safe).toBe(false);
    expect(assess(pkg("bad"), ev({ advisories: 1 })).score).toBe(0);
    expect(assess(pkg("unverifiable"), null).safety.safe).toBe(false); // fail-closed
  });
});

describe("rank — safe first, then score desc", () => {
  test("orders by safety then score; unsafe sinks to the bottom", () => {
    const r = rank([
      assess(pkg("bad"), ev({ advisories: 1 })),
      assess(pkg("good"), ev()),
      assess(pkg("ok"), ev({ scorecard: 5, adoption: 50 })),
    ]);
    expect(r.map((x) => x.candidate.name)).toEqual(["good", "ok", "bad"]);
    expect(r.map((x) => x.safety.safe)).toEqual([true, true, false]);
  });
});

describe("decideDisposition — advisory, routes real judgment calls to a human", () => {
  test("commodity + proven service, weak OSS → buy-service", () => {
    const weak = ev({ ageDays: 900, adoption: 2, scorecard: 3, license: "MPL-2.0", licenseCategory: "weak-copyleft" });
    expect(decideDisposition(cap(), rank([assess(svc("Stripe"), null), assess(pkg("weakpkg"), weak)]))).toBe("buy-service");
  });
  test("commodity + a strong OSS option leading the board → needs-human (genuine buy-vs-build)", () => {
    expect(decideDisposition(cap(), rank([assess(svc("Stripe"), null), assess(pkg("strong"), ev())]))).toBe("needs-human");
  });
  test("no service, a strong vetted package → adopt-oss", () => {
    expect(decideDisposition(cap({ knownServices: [] }), rank([assess(pkg("strong"), ev())]))).toBe("adopt-oss");
  });
  test("nothing safe off-the-shelf → build", () => {
    expect(decideDisposition(cap(), rank([assess(pkg("bad"), ev({ advisories: 1 })), assess(pkg("unk"), null)]))).toBe("build");
  });
});

describe("fallbackRationale — deterministic prose when no LLM", () => {
  test("names the call, the ruled-out option, and the operator's own decision", () => {
    const ranked = rank([assess(svc("Stripe"), null), assess(pkg("bad"), ev({ advisories: 1 }))]);
    const txt = fallbackRationale(cap(), "buy-service", ranked);
    expect(txt.length).toBeGreaterThan(20);
    expect(txt).toMatch(/Stripe|service/);
    expect(txt).toMatch(/cost|compliance|data-residency/i);
    expect(txt).toMatch(/ruled out|bad/);
  });
});
