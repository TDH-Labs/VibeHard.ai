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
  /** THE EFFECTIVE LLM key to use — the tenant's own BYO key if they have one, ELSE the
   *  operator's own platform key (see `operatorLLMKey()` below). NOT simply "the tenant's key or
   *  null": a real bug shipped live 2026-07-11 from exactly that confusion — passing
   *  `loadKey(tenantId)` here directly (null for the common, default, no-BYO-key tenant) meant
   *  assembleBuildEnv() set NO LLM key at all for the overwhelming majority of tenants, since
   *  the LOCAL-spawn path's `{...process.env}` had silently been carrying the operator's key
   *  through this whole time — a fallback this function had no way to also express. The caller
   *  is responsible for computing `byo ?? operatorLLMKey(process.env)` before setting this field. */
  byoKey: string | null;
  /** The tenant's decrypted integrations keychain (`loadIntegrations(tenantId)`). */
  integrations: Record<string, string>;
  /** Names only, no values (`integrationKeys(tenantId)`) — tells the deploy-time env collector
   *  which keys are the tenant's own, same as buildStream()'s VIBEHARD_TENANT_KEYS today. */
  integrationKeyNames: string[];
  /** Chosen design preset (#12), if any. */
  design?: string;
  /** `ship` (every build ends in one) needs these operator-level, non-tenant-specific values —
   *  found live 2026-07-11 the hard way: the first wiring of this function into the real
   *  dispatcher DIDN'T include them, meaning `ship` mode would have failed inside a sandbox with
   *  no way to deploy or encrypt the deployed app's own secrets. Explicit fields (not a blind
   *  `...process.env` fallback) so the allowlist stays provably minimal even though what it
   *  allows has grown — see this module's own test asserting the result never exceeds a known set. */
  flyApiToken?: string;
  /** The platform's master secrets-encryption key (deploy-app.ts's `defaultSubstrateDeps`
   *  passphrase) — needed because `cli.ts ship` never gets a `sql` connection (it runs as a bare
   *  subprocess, not through Platform.open()), so it falls back to a LOCAL encrypted-file store
   *  for THIS deployment's own secrets (e.g. a freshly-provisioned Supabase project's connection
   *  string) — never the platform's shared Postgres-backed store. Distributing this key to every
   *  sandbox is a real, deliberate tradeoff (broader blast radius than a scoped credential) —
   *  accepted for now because the LOCAL-spawn path already has the identical exposure today (a
   *  compromised dependency mid-build already sees this in `process.env`); a KMS-backed redesign
   *  that keeps it out of the sandbox entirely is EPIC #35, out of scope here. */
  vibehardSecretsKey?: string;
  flyOrg?: string;
  flyRegion?: string;
  /** The Supabase Management API token (SUPABASE_ACCESS_TOKEN / SUPABASE_PAT convention) —
   *  needed because assembleBuildEnv ALWAYS sets VIBEHARD_MANAGED=1 (every sandboxed build
   *  auto-provisions a Supabase project per app), and SupabaseManagementClient throws without
   *  this token. THE BUG THIS CLOSES (found live 2026-07-19, acceptance test prompt C's ship):
   *  the platform HOST has SUPABASE_PAT set — but nothing forwarded it into the sandbox, so
   *  every managed-mode ship died "missing SUPABASE_ACCESS_TOKEN (or SUPABASE_PAT)" the moment
   *  it reached backend provisioning. Same class as flyApiToken/vibehardSecretsKey above
   *  (both "found live 2026-07-11 the hard way") — an allowlist is only as good as its coverage
   *  of what ship actually needs, and this field was missing from it. */
  supabaseManagementToken?: string;
}

/** The operator's own platform LLM key — same priority order as src/config/models.ts's
 *  `providerOf()` (openrouter → opencode → anthropic by presence), so whichever provider a
 *  build's model selection resolves to matches whichever key actually got sent. Takes an
 *  env-like object (not reading `process.env` itself) so it's callable from any environment. */
export function operatorLLMKey(env: Record<string, string | undefined>): string | undefined {
  return env.OPENROUTER_API_KEY || env.OPENCODE_API_KEY || env.ANTHROPIC_API_KEY;
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
  if (parts.flyApiToken) env.FLY_API_TOKEN = parts.flyApiToken;
  if (parts.vibehardSecretsKey) env.VIBEHARD_SECRETS_KEY = parts.vibehardSecretsKey;
  if (parts.flyOrg) env.FLY_ORG = parts.flyOrg;
  if (parts.flyRegion) env.FLY_REGION = parts.flyRegion;
  if (parts.supabaseManagementToken) env.SUPABASE_ACCESS_TOKEN = parts.supabaseManagementToken;
  return env;
}
