/**
 * Persona-pack generator — AccountConfig → the exact file tree `buzz pack validate`
 * accepts (docs/agent-hosting/CONTRACTS.md, verified against the REAL binary
 * 2026-07-23). Deterministic templating, zero LLM: the same config always yields the
 * same bytes, and every emitted frontmatter key is one the deny_unknown_fields parser
 * knows — an unknown key is a HARD parse error at buzz-acp load time, so this
 * generator emits only the schema and validation REJECTS configs it can't represent
 * (fail closed, never emit-and-hope).
 *
 * YAML discipline: every string scalar is emitted via JSON.stringify — a JSON string
 * is a valid YAML double-quoted scalar, which closes injection through customer-
 * authored names/descriptions (a value containing `"\n---\n"` or `: ` cannot break
 * out of its field). The persona PROMPT is the markdown body (after the closing
 * `---`), which is free text by contract and needs no escaping.
 */
import type { AccountConfig, AgentConfig, AgentLaunchPlan, FileMap, McpServerConfig } from "./types.ts";

const NAME_RE = /^[a-z][a-z0-9-]{1,63}$/; // lowercase kebab: pack ids, agent names, skill load keys
const HEX64_RE = /^[0-9a-f]{64}$/;
const MODEL_RE = /^[a-z0-9_-]+:.+$/i; // "provider:model-id" — split on FIRST ':' by buzz-acp

/** Validate an AccountConfig against every constraint the downstream contracts impose.
 *  Returns human-readable problems; empty = generatable. Pure. */
export function validateAccountConfig(cfg: AccountConfig): string[] {
  const out: string[] = [];
  if (!NAME_RE.test(cfg.accountSlug)) out.push(`accountSlug "${cfg.accountSlug}" must be lowercase kebab-case (2-64 chars)`);
  if (!HEX64_RE.test(cfg.ownerPubkey)) out.push("ownerPubkey must be a 64-char lowercase hex Nostr pubkey");
  if (!/^wss?:\/\/.+/.test(cfg.relayUrl)) out.push(`relayUrl "${cfg.relayUrl}" must be a ws:// or wss:// URL`);
  if (cfg.agents.length === 0) out.push("at least one agent is required");
  const seen = new Set<string>();
  for (const a of cfg.agents) {
    const where = `agent "${a.name}"`;
    if (!NAME_RE.test(a.name)) out.push(`${where}: name must be lowercase kebab-case`);
    if (seen.has(a.name)) out.push(`${where}: duplicate name`);
    seen.add(a.name);
    if (!a.displayName.trim()) out.push(`${where}: displayName is required`);
    if (!a.description.trim()) out.push(`${where}: description is required`);
    if (!a.personaPrompt.trim()) out.push(`${where}: personaPrompt is required`);
    if (!MODEL_RE.test(a.model)) out.push(`${where}: model must be "provider:model-id" (got "${a.model}")`);
    if (a.temperature !== undefined && !Number.isFinite(a.temperature)) out.push(`${where}: temperature must be a finite number`);
    const skillSeen = new Set<string>();
    for (const s of a.skills) {
      if (!NAME_RE.test(s.name)) out.push(`${where}: skill "${s.name}" must be lowercase kebab-case`);
      if (skillSeen.has(s.name)) out.push(`${where}: duplicate skill "${s.name}"`);
      skillSeen.add(s.name);
      // name + description are REQUIRED by the SKILL.md contract — missing either means
      // the runtime silently skips the skill, so we refuse to generate instead.
      if (!s.description.trim()) out.push(`${where}: skill "${s.name}" needs a description (silently skipped otherwise)`);
    }
    for (const m of a.mcpServers) {
      if (!m.name.trim() || !m.command.trim()) out.push(`${where}: MCP server needs name + command`);
    }
  }
  // Hub-and-spoke needs a designated hub once there is more than one agent — the whole
  // point of the default is that spokes only take prompts from owner + hub.
  if (cfg.commsMode === "hub-and-spoke" && cfg.agents.length > 1) {
    if (!cfg.chiefOfStaff) out.push("hub-and-spoke with >1 agent requires a chiefOfStaff designation");
    else if (!cfg.agents.some((a) => a.name === cfg.chiefOfStaff)) out.push(`chiefOfStaff "${cfg.chiefOfStaff}" is not one of the agents`);
  }
  return out;
}

const y = (v: string): string => JSON.stringify(v); // YAML-safe scalar via JSON quoting

/** Frontmatter for one persona. Only schema keys, in a fixed order (determinism). */
function personaFrontmatter(a: AgentConfig): string {
  const L: string[] = ["---"];
  L.push(`name: ${y(a.name)}`);
  L.push(`display_name: ${y(a.displayName)}`);
  L.push(`description: ${y(a.description)}`);
  if (a.skills.length) {
    L.push("skills:");
    for (const s of a.skills) L.push(`  - ${y(`./skills/${s.name}/`)}`);
  }
  if (a.mcpServers.length) {
    L.push("mcp_servers:");
    for (const m of a.mcpServers) {
      L.push(`  - name: ${y(m.name)}`);
      L.push(`    command: ${y(m.command)}`);
      L.push(`    args: [${m.args.map(y).join(", ")}]`);
      const env = m.env ?? {};
      const keys = Object.keys(env).sort();
      if (keys.length) {
        L.push("    env:");
        for (const k of keys) L.push(`      ${y(k)}: ${y(env[k]!)}`);
      }
    }
  }
  if (a.subscribe.length) {
    L.push("subscribe:");
    for (const c of a.subscribe) L.push(`  - ${y(c)}`);
  }
  const t = a.triggers ?? {};
  L.push("triggers:");
  L.push(`  mentions: ${t.mentions ?? true}`);
  L.push(`  keywords: [${(t.keywords ?? []).map(y).join(", ")}]`);
  L.push(`  all_messages: ${t.allMessages ?? false}`);
  L.push(`model: ${y(a.model)}`);
  if (a.temperature !== undefined) L.push(`temperature: ${a.temperature}`);
  if (a.maxContextTokens !== undefined) L.push(`max_context_tokens: ${a.maxContextTokens}`);
  L.push("---");
  return L.join("\n");
}

/** Generate the complete persona pack for an account. Throws on an invalid config —
 *  call validateAccountConfig first for a friendly error list. */
export function generatePersonaPack(cfg: AccountConfig): FileMap {
  const problems = validateAccountConfig(cfg);
  if (problems.length) throw new Error(`invalid account config:\n- ${problems.join("\n- ")}`);

  const files: FileMap = {};
  files[".plugin/plugin.json"] =
    JSON.stringify(
      {
        $schema: "https://open-plugin-spec.org/schema/v1/plugin.json",
        id: `ai.vibehard.${cfg.accountSlug}`,
        name: cfg.accountSlug,
        version: "1.0.0",
        description: `VibeHard-hosted agents for ${cfg.accountSlug}`,
        author: "VibeHard",
        license: "Apache-2.0",
        engines: { buzz: ">=0.2.0" },
        personas: cfg.agents.map((a) => `agents/${a.name}.persona.md`),
        defaults: {
          triggers: { mentions: true, keywords: [], all_messages: false },
          thread_replies: true,
          broadcast_replies: false,
        },
      },
      null,
      2,
    ) + "\n";

  for (const a of cfg.agents) {
    files[`agents/${a.name}.persona.md`] = `${personaFrontmatter(a)}\n\n${a.personaPrompt.trim()}\n`;
    for (const s of a.skills) {
      files[`skills/${s.name}/SKILL.md`] = `---\nname: ${y(s.name)}\ndescription: ${y(s.description)}\n---\n\n${s.body.trim()}\n`;
    }
  }
  return files;
}

/** Compute each agent's buzz-acp launch plan — the respond-to gating that makes
 *  hub-and-spoke REAL (harness-enforced, not a prompt suggestion). Spokes accept
 *  prompts only from owner + chief-of-staff; the chief-of-staff accepts owner + all
 *  spokes. Mesh (opt-in) allowlists owner + every sibling for everyone. Agent pubkeys
 *  are provisioned by the lifecycle layer, so this takes a name→pubkey map and is
 *  called after identities exist. Pure. */
export function computeLaunchPlans(cfg: AccountConfig, agentPubkeys: Record<string, string>): AgentLaunchPlan[] {
  for (const a of cfg.agents) {
    const pk = agentPubkeys[a.name];
    if (!pk || !HEX64_RE.test(pk)) throw new Error(`missing/invalid pubkey for agent "${a.name}"`);
  }
  const hub = cfg.chiefOfStaff;
  return cfg.agents.map((a): AgentLaunchPlan => {
    let allow: string[];
    if (cfg.agents.length === 1) {
      allow = []; // sole agent: owner-only — no siblings to hear from
    } else if (cfg.commsMode === "mesh") {
      allow = cfg.agents.filter((b) => b.name !== a.name).map((b) => agentPubkeys[b.name]!);
    } else if (a.name === hub) {
      allow = cfg.agents.filter((b) => b.name !== hub).map((b) => agentPubkeys[b.name]!); // hub hears every spoke
    } else {
      allow = [agentPubkeys[hub!]!]; // spoke hears ONLY the hub (owner implicit)
    }
    const args =
      allow.length === 0
        ? ["--respond-to", "owner-only"]
        : ["--respond-to", "allowlist", "--respond-to-allowlist", allow.sort().join(",")];
    return {
      agentName: a.name,
      privateKeyEnvVar: "BUZZ_PRIVATE_KEY",
      env: {
        BUZZ_RELAY_URL: cfg.relayUrl,
        // GOOSE_* deliberately absent: buzz-acp injects per-persona model config from
        // the pack; setting it here would pin EVERY persona via operator precedence.
      },
      args,
    };
  });
}
