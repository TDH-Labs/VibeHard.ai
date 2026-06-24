/**
 * Runtime substrate — the seams + records (docs/runtime-substrate/). The substrate
 * turns a gated, passing app into a live, hosted app with a real managed backend, in
 * the CUSTOMER'S own Supabase org (VibeHard is the processor, never the data owner —
 * §16). Three swappable providers (backend / host / secrets) behind interfaces, one
 * durable record, one deterministic orchestrator. Zero LLM in this path (§11).
 *
 * This file is the contracts only. The real Supabase/host impls land behind these
 * seams when credentials exist; the orchestrator is fake-provider-tested today.
 */

/** The connection secrets a provisioned backend yields. */
export interface BackendSecrets {
  url: string; // SUPABASE_URL — safe to expose
  anonKey: string; // safe for the browser (RLS protects the data)
  serviceKey: string; // SERVER-SIDE ONLY — must never reach a frontend bundle/env
  // Managed mode (auto-created projects): the DB connection needed to RE-deploy. Server-side
  // only, encrypted at rest, NEVER injected into the host (the orchestrator sends only url+anon).
  // The db password is generated at creation and unrecoverable from the API → it MUST persist.
  dbHost?: string; // the pooler host (from the Management API)
  dbUser?: string; // postgres.<ref>
  dbPassword?: string;
}

/** A provisioned project in the customer's org. */
export interface BackendHandle {
  projectRef: string;
}

/** The customer's granted connection to THEIR Supabase org (token held by reference
 *  inside the provider impl — never carried in plaintext through the orchestrator). */
export interface CustomerOrg {
  orgRef: string;
}

/** One migration to apply (id = the migration filename/version, for incremental apply). */
export interface Migration {
  id: string;
  sql: string;
}

export interface MigrationResult {
  ok: boolean;
  appliedNow: string[]; // ids applied this run (excludes already-applied)
  error?: string; // set when ok === false (the first place the SQL actually runs)
}

/** Result of the post-apply LIVE-RLS probe (the differentiated step). `enforced=false`
 *  means a real anonymous/cross-tenant query saw rows it shouldn't → abort the deploy. */
export interface LiveRlsResult {
  enforced: boolean;
  leakedTables: string[];
}

/**
 * Provision + manage a backend IN THE CUSTOMER'S ORG. Supabase impl later; the seam
 * lets a Neon/other impl drop in. Every method is idempotent given the record.
 */
export interface BackendProvider {
  readonly name: string;
  /** Provision a new project (or reuse the recorded one) in the customer's org. */
  ensureProject(record: DeploymentRecord, org: CustomerOrg): Promise<{ handle: BackendHandle; secrets: BackendSecrets }>;
  /** Apply only the migrations not already applied; a SQL error → ok:false (abort). */
  applyMigrations(handle: BackendHandle, migrations: Migration[], alreadyApplied: string[]): Promise<MigrationResult>;
  /** Fire a real anonymous query against `tables`; confirm RLS denies it. */
  verifyLiveRls(handle: BackendHandle, tables: string[]): Promise<LiveRlsResult>;
  /** Configure auth (providers + redirect URLs to the deployed app). */
  configureAuth(handle: BackendHandle, appUrl: string): Promise<void>;
  /** Tear the project down (for `vibehard destroy`). */
  deleteProject(handle: BackendHandle): Promise<void>;
}

/** Deploy + manage the frontend host. Generalises the existing `DeployTarget` seam. */
export interface HostProvider {
  readonly name: string;
  deploy(workspacePath: string, env: Record<string, string>, hostRef: string | null): Promise<{ url: string; hostRef: string }>;
  teardown(hostRef: string): Promise<void>;
}

/** Store/retrieve per-app secrets, encrypted at rest. Local impl v1; cloud KMS later. */
export interface SecretsStore {
  readonly name: string;
  put(app: string, secrets: BackendSecrets): Promise<string>; // returns a ref
  get(app: string): Promise<BackendSecrets | null>;
  remove(app: string): Promise<void>;
}

export type DeployStatus = "provisioning" | "live" | "failed" | "destroyed";

/** The durable app→resources mapping: the idempotency key + lifecycle backbone. */
export interface DeploymentRecord {
  app: string;
  customerOrgRef: string;
  projectRef: string | null;
  hostRef: string | null;
  url: string | null;
  appliedMigrations: string[];
  secretsRef: string | null;
  status: DeployStatus;
  updatedAt: string;
}

/** Persistence for DeploymentRecords (file-backed v1; platform DB later). */
export interface RecordStore {
  get(app: string): DeploymentRecord | null;
  put(record: DeploymentRecord): void;
  remove(app: string): void;
}
