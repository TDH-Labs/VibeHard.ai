/**
 * GitHubEscalationSink — the live delivery surface for escalations (PROJECT_BRIEF.md §24).
 * Implements the SAME EscalationSink seam as LocalEscalationSink, so nothing above it changes:
 * a held `needs-human` ticket becomes a real GitHub ISSUE. The issue body is dual-purpose —
 * a human-readable rendering of the localized findings (the reviewer reads "these 6 lines",
 * the §7 unit-economics unlock) PLUS a base64-embedded ticket JSON so the sink round-trips the
 * full EscalationTicket (state machine intact). Claim/resolve PATCH the issue; resolve closes it.
 *
 * Token via GITHUB_PAT (env), NEVER argv/log. All HTTP behind an injectable fetch seam → the
 * whole adapter unit-tests against a fake GitHub, no network. The pure transitions (open/claim/
 * resolve in queue.ts) still enforce the lifecycle; this only persists them to issues.
 */
import type { EscalationPacket } from "./packet.ts";
import type { ReviewDecision } from "./review.ts";
import { claimTicket, openTicket, resolveTicket, ticketId, type EscalationSink, type EscalationTicket, type TicketState } from "./queue.ts";

const MARKER = "DRYDOCK_TICKET";

export interface GitHubEscalationSinkOptions {
  repo: string; // "owner/name" (DRYDOCK_ESCALATION_REPO)
  token?: string; // GITHUB_PAT
  fetchImpl?: typeof fetch;
  apiBase?: string; // default https://api.github.com
  label?: string; // default "drydock-escalation"
}

type GhIssue = { number: number; body?: string | null; html_url?: string };

/** Render the localized findings as Markdown — what a reviewer actually reads. */
function renderPacketMarkdown(t: EscalationTicket): string {
  const p = t.packet;
  const lines = [
    `**State:** \`${t.state}\`${t.claimedBy ? ` — claimed by ${t.claimedBy}` : ""}`,
    `**Reason:** ${p.reason}`,
    `**Blocking findings:** ${p.blocking} · **Specialties:** ${p.specialties.join(", ") || "—"}`,
    "",
    "---",
  ];
  for (const item of p.items) {
    lines.push(`### ${item.finding.severity.toUpperCase()} — \`${item.finding.ruleId}\` _(${item.specialty})_`);
    lines.push(item.finding.message);
    lines.push(`\`${item.finding.file}:${item.finding.line ?? "?"}\``);
    if (item.slice) lines.push("```\n" + item.slice.code + "\n```");
    lines.push("");
  }
  return lines.join("\n");
}

export class GitHubEscalationSink implements EscalationSink {
  readonly name = "github";
  private readonly repo: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly label: string;
  private readonly cache = new Map<string, number>(); // ticketId → issue number (see locate())

  constructor(opts: GitHubEscalationSinkOptions) {
    this.repo = opts.repo;
    this.token = opts.token ?? process.env.GITHUB_PAT ?? "";
    if (!this.repo) throw new Error("GitHubEscalationSink: missing repo (owner/name)");
    if (!this.token) throw new Error("GitHubEscalationSink: missing GITHUB_PAT");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = opts.apiBase ?? "https://api.github.com";
    this.label = opts.label ?? "drydock-escalation";
  }

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "drydock",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  /** Embed the full ticket as base64 (can't contain `-->`, so code slices never break the comment). */
  private renderBody(ticket: EscalationTicket): string {
    const b64 = Buffer.from(JSON.stringify(ticket), "utf8").toString("base64");
    return `${renderPacketMarkdown(ticket)}\n\n<!-- ${MARKER} ${b64} -->\n`;
  }

  private parseTicket(body: string | null | undefined): EscalationTicket | null {
    const m = (body ?? "").match(new RegExp(`${MARKER} ([A-Za-z0-9+/=]+)`));
    if (!m) return null;
    try {
      return JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8")) as EscalationTicket;
    } catch {
      return null;
    }
  }

  private async issues(): Promise<GhIssue[]> {
    // Identify OUR issues by the embedded marker, NOT a ?labels= filter: GitHub's label filter
    // lags for a just-created/just-labeled issue (eventual consistency), so the raw list is the
    // correct source of truth. The label is still applied on create — for humans, not for lookup.
    const j = await this.api("GET", `/repos/${this.repo}/issues?state=all&per_page=100`);
    return Array.isArray(j) ? (j as GhIssue[]) : [];
  }

  private async find(id: string): Promise<{ number: number; ticket: EscalationTicket } | null> {
    for (const issue of await this.issues()) {
      const t = this.parseTicket(issue.body);
      if (!t) continue;
      this.cache.set(t.id, issue.number); // remember every id→number we scan past
      if (t.id === id) return { number: issue.number, ticket: t };
    }
    return null;
  }

  /**
   * Resolve a ticketId → its issue. Prefer the cached number + a DIRECT fetch
   * (`GET /issues/{number}` is immediately consistent); fall back to scanning the list. This
   * matters because the issues LIST lags for a just-created issue — so an open() followed
   * immediately by get/claim/resolve (same process) must not depend on the list seeing it yet.
   */
  private async locate(id: string): Promise<{ number: number; ticket: EscalationTicket } | null> {
    const n = this.cache.get(id);
    if (n !== undefined) {
      try {
        const issue = (await this.api("GET", `/repos/${this.repo}/issues/${n}`)) as GhIssue;
        const t = this.parseTicket(issue.body);
        if (t && t.id === id) return { number: n, ticket: t };
      } catch {
        /* fall through to a list scan */
      }
    }
    return this.find(id);
  }

  private async require(id: string): Promise<{ number: number; ticket: EscalationTicket }> {
    const f = await this.locate(id);
    if (!f) throw new Error(`no such ticket: ${id}`);
    return f;
  }

  async open(packet: EscalationPacket, now: string = new Date().toISOString()): Promise<EscalationTicket> {
    const id = ticketId(packet);
    const existing = await this.locate(id);
    if (existing) return existing.ticket; // idempotent on packet identity (same id → same issue)
    const ticket = openTicket(packet, now);
    const created = (await this.api("POST", `/repos/${this.repo}/issues`, {
      title: `[drydock] needs-human: ${packet.reason} (${id})`,
      body: this.renderBody(ticket),
      labels: [this.label, "needs-human"],
    })) as { number?: number };
    if (created?.number !== undefined) this.cache.set(id, created.number); // so immediate lookups don't wait on list consistency
    return ticket;
  }

  async claim(id: string, reviewer: string, now: string = new Date().toISOString()): Promise<EscalationTicket> {
    const { number, ticket } = await this.require(id);
    const next = claimTicket(ticket, reviewer, now);
    await this.api("PATCH", `/repos/${this.repo}/issues/${number}`, { body: this.renderBody(next), labels: [this.label, "claimed"] });
    return next;
  }

  async resolve(id: string, decisions: ReviewDecision[], now: string = new Date().toISOString()): Promise<EscalationTicket> {
    const { number, ticket } = await this.require(id);
    const next = resolveTicket(ticket, decisions, now);
    await this.api("PATCH", `/repos/${this.repo}/issues/${number}`, { body: this.renderBody(next), labels: [this.label, "resolved"], state: "closed" });
    return next;
  }

  async get(id: string): Promise<EscalationTicket | null> {
    return (await this.locate(id))?.ticket ?? null;
  }

  async list(state?: TicketState): Promise<EscalationTicket[]> {
    const out: EscalationTicket[] = [];
    for (const issue of await this.issues()) {
      const t = this.parseTicket(issue.body);
      if (t && (!state || t.state === state)) out.push(t);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
