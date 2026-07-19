/**
 * provisionAndDeploy — the deterministic runtime-substrate orchestrator
 * (docs/runtime-substrate § W5). Turns a gated, passing app into a live one in the
 * customer's own Supabase org. Fixed sequence of provider calls, ZERO LLM (§11):
 *
 *   gate sentinel present (precondition) → ensure project → apply migrations →
 *   VERIFY LIVE RLS (abort if not enforced) → configure auth → store secrets →
 *   deploy frontend → mark live.
 *
 * "Mark live" is reached ONLY if every step passed — including the live-RLS probe,
 * the differentiated step that carries the gate guarantee into runtime. Any failure
 * leaves the record at its last good state (status "failed"), so a re-run resumes.
 * The providers are injected, so this whole flow is unit-tested with fakes.
 */
import { join } from "node:path";
import { SENTINEL_REL, verifySentinel } from "../gate/index.ts";
import type { CustomerOrg, DeploymentRecord, Migration, RecordStore, BackendProvider, HostProvider, SecretsStore } from "./types.ts";

export interface DeployInput {
  app: string;
  org: CustomerOrg;
  workspacePath: string;
  migrations: Migration[];
  rlsTables: string[]; // the tables the live-RLS probe must find denied to anon
  rlsEnabledTables?: string[]; // the subset with RLS enabled in the migrations — a probed table not here is a leak
  authRedirectUrl?: string;
  /** User-provided third-party credentials (Stripe, OAuth, email…) to inject into the running app's
   *  runtime env, alongside the Supabase vars (backlog #5). Never includes Supabase/service keys. */
  appEnv?: Record<string, string>;
  /** Client-only app (no migrations, no supabase/ dir, no @supabase/* deps — deployApp derives
   *  this deterministically): skip ALL backend provisioning and deploy the frontend only. THE BUG
   *  THIS CLOSES (found live 2026-07-19, acceptance re-run A2): a gate-green STATIC app's ship
   *  aborted at "provisioning backend" — SupabaseManagementClient demanded a management token to
   *  create a Supabase project the app would never use. Client-only apps became a real class a
   *  week ago (clientOnlyStorage + the static golden template); the deploy layer never learned. */
  backendless?: boolean;
}

export interface SubstrateDeps {
  backend: BackendProvider;
  host: HostProvider;
  secrets: SecretsStore;
  records: RecordStore;
  now?: () => string;
  onStep?: (message: string) => void;
}

export interface DeployOutcome {
  live: boolean;
  url: string | null;
  abortedAt: string | null; // which step aborted (null on success)
  reason: string;
  record: DeploymentRecord;
}

function freshRecord(input: DeployInput, now: string): DeploymentRecord {
  return {
    app: input.app,
    customerOrgRef: input.org.orgRef,
    projectRef: null,
    hostRef: null,
    url: null,
    appliedMigrations: [],
    secretsRef: null,
    status: "provisioning",
    updatedAt: now,
  };
}

/** First-deploy host name seed: the APP identity, host-safe (lowercase alnum + dashes, ≤30).
 *  Never the workspace basename — see the step-6 comment. */
function seedHostRef(app: string): string {
  return (
    app
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30)
      .replace(/-+$/, "") || "app"
  );
}

export async function provisionAndDeploy(input: DeployInput, deps: SubstrateDeps): Promise<DeployOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  const step = (m: string): void => deps.onStep?.(m);

  // §11 precondition (defense in depth): a build that didn't pass the gate must never
  // reach provisioning/deploy. verifySentinel() checks existence AND HMAC authenticity,
  // so a file created by anything other than a real gate pass (C3 fix) is rejected.
  if (!verifySentinel(input.workspacePath)) {
    throw new Error("runtime substrate refused: sentinel absent or HMAC invalid — the gate must pass before deploy");
  }

  let record = (await deps.records.get(input.app)) ?? freshRecord(input, now());
  record = { ...record, status: "provisioning", updatedAt: now() };
  await deps.records.put(record);

  const abort = async (at: string, reason: string): Promise<DeployOutcome> => {
    record = { ...record, status: "failed", updatedAt: now() };
    await deps.records.put(record);
    return { live: false, url: null, abortedAt: at, reason, record };
  };

  try {
    // 0. Backendless (client-only) app: nothing to provision, migrate, RLS-probe, or configure —
    // deploy the frontend and stop. appEnv only; no Supabase vars exist to inject.
    if (input.backendless) {
      step("client-only app — no backend to provision; deploying the frontend only");
      const deployed = await deps.host.deploy(input.workspacePath, { ...(input.appEnv ?? {}) }, record.hostRef ?? seedHostRef(input.app));
      record = { ...record, url: deployed.url, hostRef: deployed.hostRef, status: "live", updatedAt: now() };
      await deps.records.put(record);
      step(`live at ${deployed.url}`);
      return { live: true, url: deployed.url, abortedAt: null, reason: "deployed", record };
    }

    // 1. provision OR reuse the project, in the CUSTOMER's org (idempotent via record)
    step(`provisioning backend (reuse=${Boolean(record.projectRef)})`);
    const { handle, secrets } = await deps.backend.ensureProject(record, input.org);
    record = { ...record, projectRef: handle.projectRef, updatedAt: now() };
    await deps.records.put(record);

    // 2. apply only NEW migrations; a SQL error is a hard stop (first place it runs)
    step("applying migrations");
    const mig = await deps.backend.applyMigrations(handle, input.migrations, record.appliedMigrations);
    if (!mig.ok) return abort("apply-migrations", `migration failed: ${mig.error ?? "unknown"}`);
    record = { ...record, appliedMigrations: [...record.appliedMigrations, ...mig.appliedNow], updatedAt: now() };
    await deps.records.put(record);

    // 3. ⭐ verify RLS is enforced LIVE — the gate guarantee carried into runtime
    step("verifying live RLS");
    const rls = await deps.backend.verifyLiveRls(handle, input.rlsTables, input.rlsEnabledTables);
    if (!rls.enforced) {
      const reason = rls.leakedTables.length ? `an anonymous query could read: ${rls.leakedTables.join(", ")}` : `could not prove RLS for: ${rls.inconclusive.join(", ")} (failing closed)`;
      return abort("verify-live-rls", `live RLS NOT enforced — ${reason}`);
    }

    // 4. auth
    step("configuring auth");
    await deps.backend.configureAuth(handle, input.authRedirectUrl ?? record.url ?? "");

    // 5. store secrets (encrypted). Inject ONLY url + anon key into the host — the
    //    service-role key never reaches the frontend env/bundle (R6/AC6.2).
    step("storing secrets");
    const secretsRef = await deps.secrets.put(input.app, secrets);
    record = { ...record, secretsRef, updatedAt: now() };
    await deps.records.put(record);

    // 6. deploy the frontend (idempotent on hostRef; first deploy seeds the host name from the
    //    APP identity, never the workspace directory basename — in a sandbox that basename is
    //    always "workspace", a Fly app name owned by someone else entirely; found live
    //    2026-07-19, acceptance A2's ship died "unauthorized" on exactly that). Inject url +
    //    anon under the canonical
    //    AND the framework-public names (Next's NEXT_PUBLIC_*, Vite's VITE_*) so the
    //    generated app finds them however it reads them. EVERY value here is url or anon
    //    (public, RLS-gated) — the service-role key is never injected (§16/R6.2).
    step("deploying frontend");
    const hostEnv: Record<string, string> = {
      // User-provided third-party creds first; the Supabase vars below are authoritative and can
      // never be overridden by a user value (appEnv is pre-filtered of SUPABASE_*/service keys).
      ...(input.appEnv ?? {}),
      SUPABASE_URL: secrets.url,
      SUPABASE_ANON_KEY: secrets.anonKey,
      NEXT_PUBLIC_SUPABASE_URL: secrets.url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: secrets.anonKey,
      VITE_SUPABASE_URL: secrets.url,
      VITE_SUPABASE_ANON_KEY: secrets.anonKey,
    };
    const deployed = await deps.host.deploy(input.workspacePath, hostEnv, record.hostRef ?? seedHostRef(input.app));
    record = { ...record, url: deployed.url, hostRef: deployed.hostRef, updatedAt: now() };
    await deps.records.put(record);

    // 7. live — only reachable if steps 1–6 all succeeded
    record = { ...record, status: "live", updatedAt: now() };
    await deps.records.put(record);
    step(`live at ${deployed.url}`);
    return { live: true, url: deployed.url, abortedAt: null, reason: "deployed", record };
  } catch (e) {
    return abort("exception", e instanceof Error ? e.message : String(e));
  }
}

/** Crude teardown (R9, v1): delete the app's resources + clear its record. */
export async function destroy(app: string, deps: SubstrateDeps): Promise<{ destroyed: boolean }> {
  const record = await deps.records.get(app);
  if (!record) return { destroyed: false };
  if (record.projectRef) await deps.backend.deleteProject({ projectRef: record.projectRef });
  if (record.hostRef) await deps.host.teardown(record.hostRef);
  await deps.secrets.remove(app);
  await deps.records.remove(app);
  return { destroyed: true };
}
