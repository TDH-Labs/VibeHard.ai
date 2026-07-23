import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeLaunchPlans, generatePersonaPack, validateAccountConfig } from "./persona-pack.ts";
import type { AccountConfig } from "./types.ts";

const OWNER = "a".repeat(64);
const PK = (c: string) => c.repeat(64);

function account(over: Partial<AccountConfig> = {}): AccountConfig {
  return {
    tenantId: "t-1",
    accountSlug: "acme-team",
    ownerPubkey: OWNER,
    relayUrl: "wss://acme.communities.buzz.xyz",
    commsMode: "hub-and-spoke",
    placement: "shared",
    chiefOfStaff: "chief",
    agents: [
      {
        name: "chief",
        displayName: "Chief 🎯",
        description: "Chief of staff — routes work to the team",
        personaPrompt: "You are Chief, the coordination hub for this team.",
        model: "anthropic:claude-sonnet-4-20250514",
        subscribe: ["#general"],
        skills: [],
        mcpServers: [],
      },
      {
        name: "scout",
        displayName: "Scout 🔭",
        description: "Research scout",
        personaPrompt: "You are Scout. Research and summarize.",
        model: "openai:gpt-5",
        temperature: 0.3,
        subscribe: ["#research"],
        skills: [{ name: "daily-brief", description: "How to assemble the daily brief", body: "# Daily Brief\n\nSteps..." }],
        mcpServers: [{ name: "github", command: "github-mcp-server", args: ["stdio"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } }],
      },
    ],
    ...over,
  };
}

describe("validateAccountConfig — fail closed on anything the contracts reject", () => {
  test("the baseline account is valid", () => {
    expect(validateAccountConfig(account())).toEqual([]);
  });

  test("bad slug / pubkey / relay / model / empty agents all flagged", () => {
    expect(validateAccountConfig(account({ accountSlug: "Bad Slug" }))).not.toEqual([]);
    expect(validateAccountConfig(account({ ownerPubkey: "xyz" }))).not.toEqual([]);
    expect(validateAccountConfig(account({ relayUrl: "https://not-ws.example" }))).not.toEqual([]);
    expect(validateAccountConfig(account({ agents: [] }))).not.toEqual([]);
    const a = account();
    a.agents[0]!.model = "no-colon";
    expect(validateAccountConfig(a).join(" ")).toContain("provider:model-id");
  });

  test("a skill without a description is REFUSED, not emitted (silently-skipped contract)", () => {
    const a = account();
    a.agents[1]!.skills = [{ name: "x-skill", description: "  ", body: "b" }];
    expect(validateAccountConfig(a).join(" ")).toContain("silently skipped");
  });

  test("hub-and-spoke with >1 agent requires a chief-of-staff that exists", () => {
    expect(validateAccountConfig(account({ chiefOfStaff: undefined })).join(" ")).toContain("chiefOfStaff");
    expect(validateAccountConfig(account({ chiefOfStaff: "ghost" })).join(" ")).toContain("ghost");
    // single-agent accounts don't need one
    const solo = account({ chiefOfStaff: undefined });
    solo.agents = [solo.agents[0]!];
    expect(validateAccountConfig(solo)).toEqual([]);
  });
});

describe("generatePersonaPack — deterministic, schema-exact", () => {
  test("emits manifest + one persona per agent + skills at the contract paths", () => {
    const files = generatePersonaPack(account());
    expect(Object.keys(files).sort()).toEqual([
      ".plugin/plugin.json",
      "agents/chief.persona.md",
      "agents/scout.persona.md",
      "skills/daily-brief/SKILL.md",
    ]);
    const manifest = JSON.parse(files[".plugin/plugin.json"]!);
    expect(manifest.id).toBe("ai.vibehard.acme-team");
    expect(manifest.personas).toEqual(["agents/chief.persona.md", "agents/scout.persona.md"]);
  });

  test("frontmatter carries only schema keys and JSON-quoted scalars (injection-safe)", () => {
    const a = account();
    a.agents[0]!.description = 'tricky: "quoted"\n---\nname: "evil"';
    const files = generatePersonaPack(a);
    const persona = files["agents/chief.persona.md"]!;
    // the newline in the description is escaped inside the JSON string, so the
    // frontmatter still has exactly two --- fences (open + close)
    const fences = persona.split("\n").filter((l) => l.trim() === "---");
    expect(fences).toHaveLength(2);
    expect(persona).toContain('description: "tricky: \\"quoted\\"\\n---\\nname: \\"evil\\""');
  });

  test("model/temperature land in frontmatter (env projection is buzz-acp's job, verified via pack inspect)", () => {
    const files = generatePersonaPack(account());
    const scout = files["agents/scout.persona.md"]!;
    expect(scout).toContain('model: "openai:gpt-5"');
    expect(scout).toContain("temperature: 0.3");
    expect(scout).not.toContain("GOOSE_"); // env vars are derived by the harness, never embedded
  });

  test("deterministic: same config → identical bytes", () => {
    expect(generatePersonaPack(account())).toEqual(generatePersonaPack(account()));
  });

  test("throws on invalid config instead of emitting a near-miss pack", () => {
    expect(() => generatePersonaPack(account({ agents: [] }))).toThrow(/invalid account config/);
  });
});

describe("computeLaunchPlans — hub-and-spoke is harness-enforced, not a suggestion", () => {
  const pubkeys = { chief: PK("b"), scout: PK("c") };

  test("spokes allowlist ONLY the hub; the hub allowlists every spoke", () => {
    const plans = computeLaunchPlans(account(), pubkeys);
    const chief = plans.find((p) => p.agentName === "chief")!;
    const scout = plans.find((p) => p.agentName === "scout")!;
    expect(chief.args).toEqual(["--respond-to", "allowlist", "--respond-to-allowlist", PK("c")]);
    expect(scout.args).toEqual(["--respond-to", "allowlist", "--respond-to-allowlist", PK("b")]);
  });

  test("mesh (opt-in) allowlists every sibling", () => {
    const plans = computeLaunchPlans(account({ commsMode: "mesh" }), pubkeys);
    expect(plans.find((p) => p.agentName === "chief")!.args.at(-1)).toBe(PK("c"));
    expect(plans.find((p) => p.agentName === "scout")!.args.at(-1)).toBe(PK("b"));
  });

  test("a sole agent is owner-only (nothing to hear from)", () => {
    const solo = account({ chiefOfStaff: undefined });
    solo.agents = [solo.agents[0]!];
    const plans = computeLaunchPlans(solo, { chief: PK("b") });
    expect(plans[0]!.args).toEqual(["--respond-to", "owner-only"]);
  });

  test("GOOSE_* never leaks into the process env (operator precedence would pin every persona)", () => {
    for (const p of computeLaunchPlans(account(), pubkeys)) {
      expect(Object.keys(p.env).some((k) => k.startsWith("GOOSE_"))).toBe(false);
      expect(p.env.BUZZ_RELAY_URL).toBe("wss://acme.communities.buzz.xyz");
      expect(p.privateKeyEnvVar).toBe("BUZZ_PRIVATE_KEY");
    }
  });

  test("missing pubkey for an agent throws", () => {
    expect(() => computeLaunchPlans(account(), { chief: PK("b") })).toThrow(/scout/);
  });
});

// ── Integration: the REAL `buzz pack validate` binary is the final judge ─────────
// Gated on the reference build being present (dev machines with ~/dev/reference/buzz
// built, or BUZZ_CLI_BIN set); skipped cleanly elsewhere — same env-gated pattern as
// the repo's other integration tests.
const BUZZ_BIN = process.env.BUZZ_CLI_BIN ?? join(process.env.HOME ?? "", "dev/reference/buzz/target/release/buzz");
const haveBuzz = existsSync(BUZZ_BIN);

describe.skipIf(!haveBuzz)("generated pack vs the real `buzz pack validate`", () => {
  test("a generated two-agent pack validates clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "vibehard-pack-"));
    try {
      const files = generatePersonaPack(account());
      for (const [rel, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), content);
      }
      const r = Bun.spawnSync([BUZZ_BIN, "pack", "validate", dir], { stdout: "pipe", stderr: "pipe" });
      const out = `${r.stdout?.toString()}${r.stderr?.toString()}`;
      expect(r.exitCode).toBe(0);
      expect(out).toContain("Valid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
