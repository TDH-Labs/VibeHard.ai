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
