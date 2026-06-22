/**
 * Finding → plain-English dictionary (PROJECT_BRIEF.md §15 "Translation",
 * §16 differentiation). This is a **content asset we own**: it turns a scanner's
 * raw ruleId into an explanation a NON-TECHNICAL operator understands — framed by
 * consequence ("anyone could read your data"), not jargon ("RLS using(true)").
 *
 * BINDING (§16): explanations describe the risk and the fix. They NEVER claim or
 * imply compliance/certification ("HIPAA/SOC 2 compliant") — that's the one
 * overclaim a trust brand can't survive, and the exact thing we position against.
 *
 * Two tiers: EXACT (ruleIds our own gates emit, plus a few common scanner ids) and
 * KEYWORDS (substring families, so semgrep's open-ended `p/default` check_ids still
 * land in the right bucket). Anything unmatched falls to a generic explanation in
 * translate.ts — a finding is never left unexplained.
 */

/** A plain-English explanation body (the dictionary value). */
export interface Entry {
  /** Consequence-framed headline a non-technical user gets at a glance. */
  title: string;
  /** 1–3 plain sentences: what was found, why it matters, and the fix direction. */
  detail: string;
}

/** Exact matches — keyed by the ruleId (or a distinctive substring of it). */
export const EXACT: Record<string, Entry> = {
  // ── our rls gate ────────────────────────────────────────────────────────
  "rls-disabled": {
    title: "Anyone on the internet could read this table's data",
    detail:
      "A database table has no access rules, so Supabase exposes it through a public API — anyone could read every row, and often change it too. We add a rule that limits each person to only their own data before this can ship.",
  },
  "rls-policy-using-true": {
    title: "Your access rule lets every user see everyone's data",
    detail:
      "The table has security switched on, but its rule allows any signed-in caller to read all rows — so one customer could read another's records. We scope the rule to each user's own data.",
  },
  "rls-missing": {
    title: "This app reads a database table that has no security rules",
    detail:
      "The app queries a Supabase table, but no migration turns on access rules for it — so Supabase exposes that table through a public API to the whole internet. This is the exact pattern behind the well-known Supabase data leaks. We add owner-scoped access rules before this can ship.",
  },
  "rls-policy-authenticated": {
    title: "Any logged-in user can read all of this table's data",
    detail:
      "Access is switched on, but the rule only checks that someone is signed in — it doesn't limit them to their own rows. If more than one customer or team uses the app, each could read the others' data. Confirm this table is meant to be fully shared; if not, scope the rule to the row's owner (e.g. only their own records).",
  },
  // ── front-half: PRD spec-readiness (§22) ─────────────────────────────────
  "no-features": {
    title: "The plan doesn't say what to build yet",
    detail:
      "No features are defined, so there's nothing concrete to generate. List what the app should actually do first.",
  },
  "no-data-model": {
    title: "The app stores data, but the data isn't described",
    detail:
      "The plan says the app keeps data but not what — which records and fields. We can't build (or secure) a database we can't see. Describe the data the app stores.",
  },
  "no-auth-for-sensitive": {
    title: "Sensitive or shared data with no way to sign in",
    detail:
      "The plan involves sensitive or multi-user data but no login, so anyone could reach it. Decide how users sign in before building — this is the mistake behind the well-known data leaks.",
  },
  "tenant-isolation-required": {
    title: "Each customer's data needs to be walled off from the others",
    detail:
      "Several tenants will share this app's sensitive data, so each must see only their own — enforced at the database (row-level), not just the screen. Plan the per-tenant access model now; the security gate checks it after the app is built.",
  },
  "no-retention-plan": {
    title: "Sensitive data with no stated keep-or-delete plan",
    detail:
      "The plan stores sensitive data but doesn't say how long it's kept or how it's deleted. Note the retention and deletion path — this helps toward data-protection obligations; it does not by itself satisfy them.",
  },
  "sensitive-classification-gap": {
    title: "Something is marked sensitive but not classified",
    detail:
      "A piece of data is flagged sensitive without saying what kind (personal, health, financial). Classifying it decides which protections apply.",
  },
  // ── front-half: PRD completeness (§22) ───────────────────────────────────
  "requirement-coverage-gap": {
    title: "Some of what you asked for isn't written into the plan yet",
    detail:
      "One or more features from the spec have no matching requirement in the PRD, so they'd likely be missed when the app is built. Each feature needs a concrete requirement first.",
  },
  "no-acceptance-criteria": {
    title: "A requirement has no way to tell when it's done",
    detail:
      "A requirement was written with no acceptance criteria — no checkable definition of 'working'. Add specific, testable conditions so the build can be verified against them.",
  },
  "no-nfrs": {
    title: "A sensitive app with no security requirements written down",
    detail:
      "This app handles sensitive data but the PRD lists no non-functional (security) requirements. The protections it needs must be stated so the build and the gates can enforce them.",
  },
  // ── front-half: architecture (§22) ───────────────────────────────────────
  "no-workstreams": {
    title: "The build plan has no components",
    detail:
      "The architecture defines no workstreams (components), so there's nothing concrete to generate. The plan needs to break the app into buildable parts.",
  },
  "workstream-no-files": {
    title: "A component in the plan produces no files",
    detail:
      "A workstream was defined with no files to generate, so it can't build anything. Each component must own at least one file.",
  },
  "unknown-dependency": {
    title: "A component depends on something that doesn't exist",
    detail:
      "A workstream lists a dependency that isn't one of the planned components, so the build order can't be resolved. Fix the name or add the missing component.",
  },
  "dependency-cycle": {
    title: "The components depend on each other in a loop",
    detail:
      "The architecture has a circular dependency, so there's no valid order to build the components in. The graph must be acyclic (e.g. database → API → UI).",
  },
  // ── our verify gate ─────────────────────────────────────────────────────
  "health-check-failed": {
    title: "The app didn't start up reliably",
    detail:
      "When we launched the app and checked it, it didn't respond healthily on every attempt. We don't ship something that doesn't reliably run.",
  },
  "no-entry-point": {
    title: "We couldn't find a way to start the app",
    detail:
      "The project has no server to launch and no build to run, so we can't confirm it actually works. It needs a runnable entry point or a build step.",
  },
  "build-failed": {
    title: "The app failed to build",
    detail:
      "Building the app for release failed, so it can't be deployed. The build errors have to be fixed first.",
  },
  "install-failed": {
    title: "The app's dependencies couldn't be installed",
    detail:
      "Installing the libraries the app needs failed, so it can't be built or run — usually a missing or broken dependency.",
  },
  // ── fail-closed (§11) — any gate's scanner that couldn't run ─────────────
  "scan-failed": {
    title: "A security check couldn't run — we stopped to be safe",
    detail:
      "One of our security scanners failed to run, so we can't confirm the code is clean. We fail safe: nothing ships until the check actually passes (a scanner that didn't run must never look like a clean result).",
  },
  // ── common exact scanner ids (corroborated families also covered below) ──
  "sqlite-template-literal-query": {
    title: "Your database queries can be hijacked (SQL injection)",
    detail:
      "The code builds database queries by pasting user input straight into them, which lets an attacker run their own database commands — reading, changing, or deleting data. We switch to safe, parameterized queries.",
  },
  "detected-stripe-api-key": {
    title: "A secret payment key is written into the code",
    detail:
      "A live Stripe secret key is hardcoded in the source. Anyone who sees the code or the deployed bundle could charge cards or reach payment data. Secrets must come from a private environment variable, never the code.",
  },
  "stripe-access-token": {
    title: "A secret payment key is written into the code",
    detail:
      "A Stripe secret token is hardcoded in the source. Anyone who sees the code could access payment services. It must be moved to a private environment variable and the exposed key rotated.",
  },
  "private-key": {
    title: "A private cryptographic key is committed in the code",
    detail:
      "A private key is stored directly in the source. If the code is shared or deployed, that key is exposed and must be treated as compromised — moved out of the code and rotated.",
  },
};

/** Tool-level fallback — for scanners whose ruleIds are open-ended (e.g. trivy
 *  emits CVE ids, which no exact/keyword entry can enumerate). Matched on the
 *  finding's `tool` after exact + keyword, before the generic fallback. */
export const BY_TOOL: Record<string, Entry> = {
  trivy: {
    title: "A dependency has a known security vulnerability",
    detail:
      "One of the third-party libraries this app installs has a publicly disclosed vulnerability (a CVE). An attacker could exploit it through your app. Update the package to a patched version — the finding names the affected package and the version that fixes it.",
  },
};

/** Keyword families — matched as substrings of a lowercased ruleId, in order. */
export const KEYWORDS: Array<{ keys: string[]; entry: Entry }> = [
  {
    keys: ["sql", "injection", "inject"],
    entry: {
      title: "Your database queries can be hijacked (SQL injection)",
      detail:
        "User input is placed directly into a database query, which lets an attacker run their own commands against your data. The fix is to use parameterized queries that keep input as data, never code.",
    },
  },
  {
    keys: ["stripe", "secret", "api-key", "api_key", "apikey", "access-token", "token", "credential", "password"],
    entry: {
      title: "A secret is hardcoded in the code",
      detail:
        "A key, token, or password is written directly into the source. Anyone who sees the code could use it. Secrets must come from private environment variables, and any exposed secret should be rotated.",
    },
  },
  {
    keys: ["xss", "cross-site-scripting"],
    entry: {
      title: "Users could be shown malicious content (cross-site scripting)",
      detail:
        "Untrusted input is rendered into the page without being escaped, so an attacker could run scripts in another user's browser — stealing sessions or data. Input must be escaped or sanitized before display.",
    },
  },
  {
    keys: ["eval", "command-injection", "rce", "code-injection"],
    entry: {
      title: "The app could be tricked into running attacker code",
      detail:
        "The code runs commands or evaluates strings built from input, which can let an attacker execute their own code on the server. The dangerous call should be removed or strictly constrained.",
    },
  },
  {
    keys: ["ssrf", "server-side-request"],
    entry: {
      title: "The app could be tricked into making requests for an attacker",
      detail:
        "The app fetches URLs built from input, so an attacker could point it at internal systems. Outbound requests must be restricted to an allowed set of destinations.",
    },
  },
  {
    keys: ["path-traversal", "path-travers", "directory-traversal"],
    entry: {
      title: "An attacker could reach files outside the intended folder",
      detail:
        "A file path is built from input without restriction, so an attacker could read or write files elsewhere on the server. Paths must be validated and confined to the intended directory.",
    },
  },
  {
    keys: ["deserial"],
    entry: {
      title: "Unsafe data handling could let an attacker run code",
      detail:
        "The app reconstructs objects from untrusted data, which can execute attacker-controlled code. Use a safe format and validate input before parsing.",
    },
  },
  {
    keys: ["redirect"],
    entry: {
      title: "The app could send users to a malicious site (open redirect)",
      detail:
        "A redirect destination is taken from input, so an attacker could forward users to a phishing site under your app's name. Redirects must be limited to known, allowed destinations.",
    },
  },
  {
    keys: ["crypto", "cipher", "hash", "md5", "sha1"],
    entry: {
      title: "Weak or misused cryptography",
      detail:
        "The code uses a weak or outdated cryptographic method, which can be broken to expose protected data. It should be replaced with a current, strong algorithm.",
    },
  },
];
