/**
 * assembleBuildEnv — the EXPLICIT allowlist of env vars a build subprocess needs
 * (docs/build-substrate/{SPEC,PRD,ARCHITECTURE}.md, SPEC decision #8). Deliberately NOT
 * `{...process.env, ...}` — that's what web/server.ts's own `buildStream()` still does for its
 * LOCAL spawn (unchanged; still live production code, not touched by this workstream), and it's
 * fine there: a same-host child process inherits the operator's env either way. It stops being
 * fine once "whatever runs the pipeline" is a sandboxed BuildWorker a scoped token hands env to
 * over the network (W5b) — spreading `process.env` would leak DATABASE_URL, session secrets, and
 * every unrelated operator credential into a multi-tenant sandbox that only ever needed an LLM
 * key and a handful of integration values.
 *
 * Same key logic as buildStream()'s env assembly (web/server.ts), factored out as a pure
 * function so it's independently testable and provably minimal — every key it can possibly set
 * is visible by reading this one function, not by auditing everything `process.env` might hold.
 */
export interface BuildEnvParts {
  /** The tenant's BYO LLM key (`loadKey(tenantId)`), or null if they're on the platform key. */
  byoKey: string | null;
  /** The tenant's decrypted integrations keychain (`loadIntegrations(tenantId)`). */
  integrations: Record<string, string>;
  /** Names only, no values (`integrationKeys(tenantId)`) — tells the deploy-time env collector
   *  which keys are the tenant's own, same as buildStream()'s VIBEHARD_TENANT_KEYS today. */
  integrationKeyNames: string[];
  /** Chosen design preset (#12), if any. */
  design?: string;
}

export function assembleBuildEnv(parts: BuildEnvParts): Record<string, string> {
  const env: Record<string, string> = { VIBEHARD_MANAGED: "1" };
  if (parts.byoKey) {
    if (parts.byoKey.startsWith("sk-ant-")) env.ANTHROPIC_API_KEY = parts.byoKey;
    else if (parts.byoKey.startsWith("sk-or-")) env.OPENROUTER_API_KEY = parts.byoKey;
    else env.OPENCODE_API_KEY = parts.byoKey; // other OpenAI-compatible / gateway key
  }
  Object.assign(env, parts.integrations);
  env.VIBEHARD_TENANT_KEYS = parts.integrationKeyNames.join(",");
  if (parts.design) env.VIBEHARD_DESIGN = parts.design;
  return env;
}
