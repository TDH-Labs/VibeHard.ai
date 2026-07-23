/**
 * buzz-cli wrapper — the provisioning seam the portal backend calls (channel create /
 * join / membership), honoring the CLI's verified contract (docs/agent-hosting/
 * CONTRACTS.md): JSON on stdout, JSON error {error, message} on stderr, exit codes
 * 0=ok 1=user 2=network 3=auth 4=other 5=write-conflict. Live-verified against
 * onboarding.communities.buzz.xyz (403 relay_membership_required → exit 3).
 *
 * The exec boundary is injectable (same discipline as the gates' container seam) so
 * unit tests run against fakes; the default impl is Bun.spawnSync on the real binary.
 * SECRETS: the agent private key enters via env only — never argv (visible in `ps`),
 * never logged. Callers pass a key PROVIDER (() => string) so the key lives in memory
 * for the duration of one call, not on this module's state.
 */
/** Per-invocation subprocess budget. buzz-cli calls are single REST round-trips —
 *  60s comfortably covers a slow relay without letting a hung binary wedge a request
 *  handler. (The shared timeouts module lives on another in-flight branch; fold this
 *  constant into it when the branches merge.) */
const SUBPROCESS_TIMEOUT_MS = 60_000;

export interface BuzzExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type BuzzExec = (argv: string[], env: Record<string, string>) => BuzzExecResult;

/** Default exec: the real binary (BUZZ_CLI_BIN or `buzz` on PATH), inheriting NOTHING
 *  from process.env except PATH/HOME — the explicit-allowlist posture (SPEC decision #8
 *  in the build substrate) applied to a new subprocess boundary. */
export const realBuzzExec: BuzzExec = (argv, env) => {
  const bin = process.env.BUZZ_CLI_BIN ?? "buzz";
  const r = Bun.spawnSync([bin, ...argv], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  return { exitCode: r.exitCode ?? 4, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
};

export type BuzzErrorKind = "user" | "network" | "auth" | "other" | "write-conflict";
const KIND_BY_EXIT: Record<number, BuzzErrorKind> = { 1: "user", 2: "network", 3: "auth", 4: "other", 5: "write-conflict" };

export type BuzzResult<T> = { ok: true; data: T } | { ok: false; kind: BuzzErrorKind; message: string };

export interface BuzzClientOptions {
  relayUrl: string;
  /** Provides the acting identity's Nostr secret key (hex or nsec). Called per
   *  invocation; the wrapper never stores the value. */
  privateKey: () => string;
  exec?: BuzzExec;
}

/** Run one buzz-cli command as the configured identity, parsing per the contract. */
export function runBuzz<T = unknown>(opts: BuzzClientOptions, argv: string[]): BuzzResult<T> {
  const exec = opts.exec ?? realBuzzExec;
  const r = exec(argv, { BUZZ_RELAY_URL: opts.relayUrl, BUZZ_PRIVATE_KEY: opts.privateKey() });
  if (r.exitCode === 0) {
    try {
      return { ok: true, data: (r.stdout.trim() ? JSON.parse(r.stdout) : null) as T };
    } catch {
      return { ok: false, kind: "other", message: `buzz-cli exit 0 but non-JSON stdout: ${r.stdout.slice(0, 200)}` };
    }
  }
  const kind = KIND_BY_EXIT[r.exitCode] ?? "other";
  let message = r.stderr.trim().slice(0, 500);
  try {
    const parsed = JSON.parse(r.stderr) as { message?: string; error?: string };
    message = parsed.message ?? parsed.error ?? message;
  } catch {
    /* non-JSON stderr → raw text already captured */
  }
  return { ok: false, kind, message: message || `buzz-cli failed (exit ${r.exitCode})` };
}

// ── The provisioning operations the portal backend actually needs ────────────────

export interface BuzzChannel {
  id: string;
  name: string;
}

export function listChannels(opts: BuzzClientOptions): BuzzResult<BuzzChannel[]> {
  return runBuzz<BuzzChannel[]>(opts, ["channels", "list"]);
}

export function createChannel(opts: BuzzClientOptions, name: string, visibility: "open" | "private" = "private"): BuzzResult<BuzzChannel> {
  return runBuzz<BuzzChannel>(opts, ["channels", "create", "--name", name, "--type", "stream", "--visibility", visibility]);
}

export function joinChannel(opts: BuzzClientOptions, channelId: string): BuzzResult<unknown> {
  return runBuzz(opts, ["channels", "join", "--channel", channelId]);
}

export function addChannelMember(opts: BuzzClientOptions, channelId: string, pubkey: string): BuzzResult<unknown> {
  return runBuzz(opts, ["channels", "add-member", "--channel", channelId, "--pubkey", pubkey]);
}
