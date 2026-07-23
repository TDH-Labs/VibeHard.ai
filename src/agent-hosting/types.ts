/**
 * Agent-hosting v1 (docs/agent-hosting-platform-scope.md) — the typed configs the
 * customer wizard produces and the deterministic generators consume. Same "structured
 * data model → deterministic generation" discipline as src/backend/model.ts: the LLM
 * (or the customer) proposes values, code disposes the artifacts. Every field here maps
 * onto a VERIFIED external contract (docs/agent-hosting/CONTRACTS.md) — the persona-pack
 * frontmatter parser is deny_unknown_fields, so schema fidelity is load-bearing, not
 * cosmetic.
 */

/** One MCP server attachment (a "skill/tool" in wizard terms). stdio or streamable_http
 *  ONLY — SSE is rejected by the ACP runtime at session start (CONTRACTS.md §persona pack). */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  /** Env for the MCP server process. NOTE: ${VAR} interpolation is NOT implemented in
   *  buzz-acp yet (passes through literally) — real secrets must reach the process
   *  environment via the Machine env, never via this map. */
  env?: Record<string, string>;
}

/** One skill: a markdown instruction set the agent can load on demand. name and
 *  description are REQUIRED by the SKILL.md frontmatter contract — a skill missing
 *  either is silently skipped by the runtime (no fallback to directory name). */
export interface SkillConfig {
  /** Load key + directory name. Lowercase kebab-case enforced at generation. */
  name: string;
  description: string;
  /** Markdown body (after frontmatter). */
  body: string;
}

/** The wizard's per-agent output — everything needed to generate the persona pack
 *  entry and the buzz-acp launch env for this one agent identity. */
export interface AgentConfig {
  /** Machine name / persona id. Lowercase, no spaces, unique within the account. */
  name: string;
  displayName: string;
  description: string;
  /** The persona prompt (markdown body of .persona.md). Customer-authored free text. */
  personaPrompt: string;
  /** "provider:model-id" — split on the FIRST ':' into GOOSE_PROVIDER/GOOSE_MODEL by
   *  buzz-acp. Validated to contain exactly that shape at generation. */
  model: string;
  temperature?: number;
  maxContextTokens?: number;
  /** Channel names to monitor ('#' prefix optional — stripped by buzz-acp). */
  subscribe: string[];
  /** Respond when @mentioned (default true) / on keywords / to everything. */
  triggers?: { mentions?: boolean; keywords?: string[]; allMessages?: boolean };
  skills: SkillConfig[];
  mcpServers: McpServerConfig[];
}

/** Inter-agent comms governance (the token-burn bound). hub-and-spoke is the ONLY
 *  default: spokes accept prompts solely from the owner + the chief-of-staff, so
 *  chatter is O(N) through the hub, never O(N²) mesh. Mesh is opt-in per account. */
export type CommsMode = "hub-and-spoke" | "mesh";

/** Compute placement — the honest pricing lever. shared = all the account's agents run
 *  as separate buzz-acp processes on ONE Fly Machine (cheaper, passed through);
 *  isolated = one Machine per agent. NOTE (verified): buzz-acp --agents N is N workers
 *  for ONE identity — never the mechanism for multi-agent accounts. */
export type ComputePlacement = "shared" | "isolated";

/** The wizard's account-level output. */
export interface AccountConfig {
  /** Tenant id in our platform (not a Buzz concept). */
  tenantId: string;
  /** Pack id/name derive from this. Lowercase kebab-case. */
  accountSlug: string;
  /** The customer's own Nostr pubkey (64-char hex) — becomes every agent's owner. */
  ownerPubkey: string;
  /** Managed community relay, e.g. wss://{community}.communities.buzz.xyz */
  relayUrl: string;
  agents: AgentConfig[];
  /** Which agent (by name) is the chief-of-staff hub. Required when agents > 1 and
   *  commsMode is hub-and-spoke. */
  chiefOfStaff?: string;
  commsMode: CommsMode;
  placement: ComputePlacement;
}

/** A generated file tree, path → content. Written verbatim; deterministic given the
 *  same config (no timestamps, no randomness — same input, same bytes). */
export type FileMap = Record<string, string>;

/** The per-agent buzz-acp launch environment (the Machine process env), computed
 *  deterministically from the account config. The private key is NOT here — it is a
 *  per-agent secret injected by the lifecycle layer at Machine provision time, keyed
 *  by `privateKeyEnvVar`. */
export interface AgentLaunchPlan {
  agentName: string;
  /** Name of the env var the lifecycle layer must populate with this agent's Nostr
   *  secret key (e.g. BUZZ_PRIVATE_KEY — one process per identity, so no suffixing). */
  privateKeyEnvVar: "BUZZ_PRIVATE_KEY";
  /** Full env for THIS agent's buzz-acp process (minus the secret). Per-agent GOOSE_*
   *  vars are injected by buzz-acp from the pack — they must NOT appear here, or the
   *  operator-precedence rule (level 1) would pin every persona to one model. */
  env: Record<string, string>;
  /** CLI args after `buzz-acp` (respond-to gating lives here, not in the pack). */
  args: string[];
}
