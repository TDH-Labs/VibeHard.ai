/**
 * GitHub push-webhook handling for "git repo = shared state" (roadmap Phase 4, live half). When an
 * SWE pushes a fix from their own editor, GitHub posts a signed webhook; this turns that raw HTTP
 * payload into a "wake the loop" intent — but ONLY after verifying the signature, and NEVER for
 * VibeHard's own pushes (which would loop forever).
 *
 * Pure functions over the raw request → unit-tested offline with a known secret; no live GitHub.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time check that a webhook body really came from GitHub (HMAC-SHA256 with the app's
 *  webhook secret, compared against the `X-Hub-Signature-256` header). False on any mismatch. */
export function verifyWebhookSignature(secret: string, rawBody: string, signature256: string | undefined | null): boolean {
  if (!secret || !signature256) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature256);
  return a.length === b.length && timingSafeEqual(a, b); // length check first: timingSafeEqual throws on length mismatch
}

export interface WakeIntent {
  /** "wake" → an SWE pushed; pull + re-gate. "ignore" → not actionable (wrong event, our own push, …). */
  kind: "wake" | "ignore";
  repo?: string; // "owner/name"
  branch?: string;
  /** the new tip sha — what to pull + re-gate against. */
  after?: string;
  /** the app installation that sent it — the loop mints a scoped token for this id (see app-auth.ts). */
  installationId?: number;
  pusher?: string;
  reason?: string;
}

export interface InterpretOptions {
  /** Bot/app logins whose pushes are VibeHard's OWN — ignore them so we never wake on our own commit. */
  ignoreActors?: string[];
  /** Only wake for branches matching this (e.g. "vibehard/"); omit to wake for any branch. */
  branchPrefix?: string;
}

/** Turn a verified webhook (headers + parsed-or-raw body) into a wake/ignore decision. Caller MUST
 *  verifyWebhookSignature first — this trusts the body. Resilient to a malformed payload (→ ignore). */
export function interpretPushWebhook(headers: Record<string, string | undefined>, rawBody: string, opts: InterpretOptions = {}): WakeIntent {
  const event = headers["x-github-event"] ?? headers["X-GitHub-Event"];
  if (event !== "push") return { kind: "ignore", reason: `not a push event (${event ?? "none"})` };

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { kind: "ignore", reason: "unparseable payload" };
  }

  const ref = typeof body.ref === "string" ? body.ref : "";
  const branch = ref.replace(/^refs\/heads\//, "");
  const repo = (body.repository as { full_name?: string } | undefined)?.full_name;
  const after = typeof body.after === "string" ? body.after : undefined;
  const installationId = (body.installation as { id?: number } | undefined)?.id;
  const pusher = (body.pusher as { name?: string } | undefined)?.name ?? (body.sender as { login?: string } | undefined)?.login;

  // a branch deletion pushes the zero-sha — nothing to gate
  if (!branch || !after || /^0+$/.test(after)) return { kind: "ignore", reason: "no commit to gate (deletion or empty ref)", repo, branch };
  if (opts.branchPrefix && !branch.startsWith(opts.branchPrefix)) return { kind: "ignore", reason: `branch ${branch} outside ${opts.branchPrefix}`, repo, branch };
  // our OWN push fired this webhook → do not wake (infinite loop). Match the sender login.
  const senderLogin = (body.sender as { login?: string } | undefined)?.login;
  if (senderLogin && opts.ignoreActors?.some((a) => a.toLowerCase() === senderLogin.toLowerCase())) {
    return { kind: "ignore", reason: `VibeHard's own push (${senderLogin})`, repo, branch };
  }
  return { kind: "wake", repo, branch, after, installationId, pusher };
}
