/**
 * Runtime substrate (docs/runtime-substrate/) — the last mile that turns a gated,
 * passing app into a live, hosted app in the CUSTOMER's own Supabase org. This module
 * is the deterministic core: the provider seams, the record + encrypted secrets stores,
 * and the orchestrator. The real Supabase/host provider impls land behind the seams
 * once credentials exist; everything here is fake-provider-tested.
 */
export type {
  BackendProvider,
  BackendHandle,
  BackendSecrets,
  CustomerOrg,
  DeploymentRecord,
  DeployStatus,
  HostProvider,
  LiveRlsResult,
  Migration,
  MigrationResult,
  RecordStore,
  SecretsStore,
} from "./types.ts";
export { FileRecordStore } from "./record.ts";
export { LocalEncryptedSecretsStore } from "./secrets.ts";
export { provisionAndDeploy, destroy, type DeployInput, type DeployOutcome, type SubstrateDeps } from "./orchestrator.ts";
export { SupabaseBackendProvider, refFromUrl, resolveDbUrl, type SupabaseEnv, type SupabaseProviderOptions, type DbExecutor } from "./supabase.ts";
export { VercelHostProvider, bunRunner, sanitizeProjectName, firstVercelUrl, type CommandRunner, type CommandResult, type VercelHostOptions } from "./vercel.ts";
export { deployApp, defaultSubstrateDeps, parseMigrations, tablesFromMigrations, type DeployAppOptions } from "./deploy-app.ts";
