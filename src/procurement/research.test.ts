import { describe, expect, test } from "bun:test";
import { researchCapability, researchProcurement } from "./research.ts";
import { capabilitiesFromSpec } from "./capabilities.ts";
import { combinedCandidateSource, npmSearchCandidateSource, registryCandidateSource } from "./candidates-npm.ts";
import { depsDevEvidenceProvider } from "./evidence-depsdev.ts";
import type { Candidate, CandidateSource, Capability, Evidence, EvidenceProvider, Summarizer } from "./types.ts";
import type { Spec } from "../spec/index.ts";

const spec = (over: Partial<Spec> = {}): Spec => ({
  name: "shopapp",
  summary: "checkout and billing for a store",
  features: ["take a payment", "send an email receipt"],
  users: "",
  tenancy: "multi-tenant",
  deployTarget: "hosted-app",
  auth: "email-password",
  storesData: true,
  dataEntities: [],
  sensitiveData: [],
  realUsers: true,
  maintained: true,
  ...over,
});

const ev = (over: Partial<Evidence> = {}): Evidence => ({
  license: "MIT",
  licenseCategory: "permissive",
  lastReleaseISO: "2026-06-01",
  ageDays: 30,
  deprecated: false,
  archived: false,
  advisories: 0,
  scorecard: 8,
  adoption: 2000,
  ...over,
});

const cap: Capability = { key: "payments", need: "take payments", searchTerms: ["payments"], knownServices: ["Stripe"] };
const fakeCandidates: CandidateSource = async () => [
  { kind: "service", name: "Stripe", source: "registry" },
  { kind: "package", name: "clean-pay", source: "npm-search", ecosystem: "npm" },
  { kind: "package", name: "vuln-pay", source: "npm-search", ecosystem: "npm" },
];
const fakeEvidence: EvidenceProvider = async (c) => (c.name === "vuln-pay" ? ev({ advisories: 3 }) : c.name === "clean-pay" ? ev() : null);

describe("capabilitiesFromSpec", () => {
  test("seeds research capabilities from the commodity categories the spec implies", () => {
    const caps = capabilitiesFromSpec(spec());
    const keys = caps.map((c) => c.key);
    expect(keys).toContain("payments");
    const pay = caps.find((c) => c.key === "payments")!;
    expect(pay.knownServices).toContain("Stripe");
    expect(pay.searchTerms).toContain("payments");
  });
});

describe("researchCapability — discover → vet → rank → decide", () => {
  test("ranks vetted options (safe first), skips evidence for services, falls back to deterministic prose", async () => {
    const adv = await researchCapability(cap, { candidateSource: fakeCandidates, evidenceProvider: fakeEvidence });
    expect(adv.options.map((o) => o.candidate.name)).toEqual(["clean-pay", "Stripe", "vuln-pay"]);
    expect(adv.options.find((o) => o.candidate.name === "Stripe")!.evidence).toBeNull(); // services aren't evidence-probed
    expect(adv.rationale.length).toBeGreaterThan(0);
  });

  test("§11/safety: a vulnerable package is NEVER safe and NEVER outranks a clean one", async () => {
    const adv = await researchCapability(cap, { candidateSource: fakeCandidates, evidenceProvider: fakeEvidence });
    const vuln = adv.options.find((o) => o.candidate.name === "vuln-pay")!;
    const clean = adv.options.find((o) => o.candidate.name === "clean-pay")!;
    expect(vuln.safety.safe).toBe(false);
    expect(vuln.score).toBe(0);
    expect(adv.options.indexOf(clean)).toBeLessThan(adv.options.indexOf(vuln));
  });

  test("the LLM summarizer writes the prose but receives the already-vetted ranking", async () => {
    let received: { key: string; names: string[] } | null = null;
    const fakeSummarizer: Summarizer = async (c, ranked) => {
      received = { key: c.key, names: ranked.map((r) => r.candidate.name) };
      return "Use clean-pay; just confirm the pricing fits.";
    };
    const adv = await researchCapability(cap, { candidateSource: fakeCandidates, evidenceProvider: fakeEvidence, summarizer: fakeSummarizer });
    expect(adv.rationale).toBe("Use clean-pay; just confirm the pricing fits.");
    expect(received!.key).toBe("payments");
    expect(received!.names[0]).toBe("clean-pay"); // safety already decided before the LLM saw it
  });
});

describe("researchProcurement — many capabilities", () => {
  test("a capability with only a proven service → buy-service", async () => {
    const source: CandidateSource = async (c) => (c.key === "payments" ? fakeCandidates(c) : [{ kind: "service", name: "Resend", source: "registry" } as Candidate]);
    const advs = await researchProcurement([cap, { key: "email & notifications", need: "send email", searchTerms: ["email"], knownServices: ["Resend"] }], {
      candidateSource: source,
      evidenceProvider: fakeEvidence,
    });
    expect(advs.length).toBe(2);
    expect(advs[1]!.disposition).toBe("buy-service");
  });
});

describe("candidate discovery — the part that actually looks (keyless, fake fetch)", () => {
  test("npmSearchCandidateSource queries the keyless npm search API and parses packages", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ objects: [{ package: { name: "pdfkit", description: "make pdfs", links: { repository: "https://github.com/foliojs/pdfkit" } } }] }) };
    }) as unknown as typeof fetch;
    const cands = await npmSearchCandidateSource({ fetchImpl: fakeFetch, limit: 3 })({ key: "pdf", need: "", searchTerms: ["pdf", "generate"], knownServices: [] });
    expect(calledUrl).toContain("registry.npmjs.org/-/v1/search");
    expect(calledUrl).toContain("pdf%20generate");
    expect(calledUrl).toContain("size=3");
    expect(cands[0]).toMatchObject({ kind: "package", name: "pdfkit", ecosystem: "npm", source: "npm-search", repoUrl: "https://github.com/foliojs/pdfkit" });
  });

  test("registry source surfaces curated services; combined merges both; a failed search degrades to []", async () => {
    expect(await registryCandidateSource({ key: "payments", need: "", searchTerms: [], knownServices: ["Stripe"] })).toEqual([{ kind: "service", name: "Stripe", source: "registry" }]);
    const failing = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    const combined = combinedCandidateSource(registryCandidateSource, npmSearchCandidateSource({ fetchImpl: failing }));
    const cands = await combined({ key: "payments", need: "", searchTerms: ["payments"], knownServices: ["Stripe"] });
    expect(cands).toEqual([{ kind: "service", name: "Stripe", source: "registry" }]); // service kept, failed search added nothing
  });
});

describe("evidence layer — composes npm + deps.dev into deterministic facts (fake fetch)", () => {
  const fetchOf = (routes: Record<string, unknown>) =>
    (async (url: string) => ({ ok: url in routes, json: async () => routes[url] ?? {} })) as unknown as typeof fetch;

  test("a healthy MIT package → permissive, 0 advisories, scorecard, fresh age", async () => {
    const routes = {
      "https://registry.npmjs.org/clean-pay": { "dist-tags": { latest: "1.2.0" }, time: { "1.2.0": "2026-06-01T00:00:00Z" }, license: "MIT", versions: { "1.2.0": {} } },
      "https://api.deps.dev/v3/systems/npm/packages/clean-pay": { versions: [{ versionKey: { version: "1.2.0" }, isDefault: true }] },
      "https://api.deps.dev/v3/systems/npm/packages/clean-pay/versions/1.2.0": { licenses: ["MIT"], advisoryKeys: [], relatedProjects: [{ relationType: "SOURCE_REPO", projectKey: { id: "github.com/foo/clean-pay" } }] },
      "https://api.deps.dev/v3/projects/github.com%2Ffoo%2Fclean-pay": { scorecard: { overallScore: 8.2 } },
    };
    const e = await depsDevEvidenceProvider({ fetchImpl: fetchOf(routes), nowISO: "2026-06-21T00:00:00Z" })({ kind: "package", name: "clean-pay", source: "npm-search", ecosystem: "npm" });
    expect(e).not.toBeNull();
    expect(e!.licenseCategory).toBe("permissive");
    expect(e!.advisories).toBe(0);
    expect(e!.scorecard).toBeCloseTo(8.2);
    expect(e!.ageDays).toBe(20);
  });

  test("a vulnerable GPL package → strong-copyleft + advisory count (the core will then block it)", async () => {
    const routes = {
      "https://registry.npmjs.org/vuln-pay": { "dist-tags": { latest: "0.1.0" }, time: { "0.1.0": "2022-01-01T00:00:00Z" }, license: "GPL-3.0", versions: { "0.1.0": {} } },
      "https://api.deps.dev/v3/systems/npm/packages/vuln-pay": { versions: [{ versionKey: { version: "0.1.0" }, isDefault: true }] },
      "https://api.deps.dev/v3/systems/npm/packages/vuln-pay/versions/0.1.0": { licenses: ["GPL-3.0"], advisoryKeys: [{ id: "GHSA-x" }, { id: "GHSA-y" }], relatedProjects: [] },
    };
    const e = await depsDevEvidenceProvider({ fetchImpl: fetchOf(routes), nowISO: "2026-06-21T00:00:00Z" })({ kind: "package", name: "vuln-pay", source: "npm-search", ecosystem: "npm" });
    expect(e!.advisories).toBe(2);
    expect(e!.licenseCategory).toBe("strong-copyleft");
  });

  test("a service candidate gets no evidence (it's curated, not probed)", async () => {
    const e = await depsDevEvidenceProvider({ fetchImpl: fetchOf({}) })({ kind: "service", name: "Stripe", source: "registry" });
    expect(e).toBeNull();
  });
});
