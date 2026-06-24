/**
 * Escalation queue + the `needs-human` HELD state (PROJECT_BRIEF.md §24). The
 * decoupler: when auto-fix exhausts, the app does NOT become a failed build — it
 * enters a distinct `needs-human` state and the escalation is QUEUED for async
 * human review, so human latency (minutes-to-hours) never sits on the deploy
 * pipeline's synchronous path. Only the re-gate (resume.ts) returns to that path.
 *
 * Pure, guarded state transitions (openTicket / claimTicket / resolveTicket) are
 * separated from persistence (the `EscalationSink` seam). `LocalEscalationSink` is
 * a file-backed queue — the MVP surface and the test surface; a future
 * GitHubEscalationSink (Issue/PR + Slack alert) implements the SAME seam when a
 * repo + token exist, so nothing above the seam changes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EscalationPacket } from "./packet.ts";
import type { ReviewDecision } from "./review.ts";

/** Lifecycle. `needs-human` is a HELD state — a distinct outcome, not a failure. */
export type TicketState = "needs-human" | "claimed" | "resolved";

/** One queued escalation: the structured request (packet) + its review state and
 *  the structured response (decisions), as it moves needs-human → claimed → resolved. */
export interface EscalationTicket {
  id: string;
  state: TicketState;
  packet: EscalationPacket; // the request: localized findings + routing
  claimedBy: string | null;
  decisions: ReviewDecision[]; // the response: confirmed-fix / waiver verdicts
  createdAt: string;
  updatedAt: string;
}

/** FNV-1a (32-bit) → base36. A tiny, dependency-free, deterministic string hash. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Deterministic id from packet content (resume-safe — no random, no clock read),
 *  so re-queuing the same escalation maps to the same ticket instead of duplicating. */
export function ticketId(packet: EscalationPacket): string {
  const seed = `${packet.workspacePath}|${packet.createdAt}|${packet.blocking}|${packet.items.map((i) => i.ref).join(",")}`;
  return `esc-${hash(seed)}`;
}

// ── Pure, guarded transitions ────────────────────────────────────────────────

export function openTicket(packet: EscalationPacket, now: string): EscalationTicket {
  // Fail-closed at the queue boundary: an unrouted packet (no specialties) could never be claimed
  // (matchesPacket rejects it), so it would sit stuck forever. Refuse to queue it — it's a bug upstream.
  if (!packet.specialties.length) throw new Error(`cannot queue ${ticketId(packet)}: packet has no specialties (routing bug)`);
  return { id: ticketId(packet), state: "needs-human", packet, claimedBy: null, decisions: [], createdAt: now, updatedAt: now };
}

/** Claim a held ticket (FCFS). Only a `needs-human` ticket can be claimed. */
export function claimTicket(t: EscalationTicket, reviewer: string, now: string): EscalationTicket {
  if (t.state !== "needs-human") throw new Error(`cannot claim ${t.id}: state is ${t.state}, expected needs-human`);
  if (!reviewer.trim()) throw new Error(`cannot claim ${t.id}: a reviewer is required (FCFS accountability)`);
  return { ...t, state: "claimed", claimedBy: reviewer, updatedAt: now };
}

/** Resolve a claimed ticket with the reviewer's decisions. Must be claimed first —
 *  the claim is the accountability record for who judged it. */
export function resolveTicket(t: EscalationTicket, decisions: ReviewDecision[], now: string): EscalationTicket {
  if (t.state !== "claimed") throw new Error(`cannot resolve ${t.id}: state is ${t.state}, expected claimed`);
  if (!decisions.length) throw new Error(`cannot resolve ${t.id}: at least one decision is required`);
  return { ...t, state: "resolved", decisions, updatedAt: now };
}

// ── The sink seam ────────────────────────────────────────────────────────────

/** Where escalations are delivered, claimed, and resolved. The seam over the
 *  delivery surface: `LocalEscalationSink` (files) for MVP/testing; a
 *  GitHubEscalationSink (Issue/PR + Slack alert) implements the same contract. */
export interface EscalationSink {
  readonly name: string;
  /** Enqueue a packet as a held `needs-human` ticket. Idempotent on packet identity. */
  open(packet: EscalationPacket, now?: string): Promise<EscalationTicket>;
  claim(id: string, reviewer: string, now?: string): Promise<EscalationTicket>;
  resolve(id: string, decisions: ReviewDecision[], now?: string): Promise<EscalationTicket>;
  get(id: string): Promise<EscalationTicket | null>;
  list(state?: TicketState): Promise<EscalationTicket[]>;
}

// ── Local file-backed adapter (the MVP queue + the test surface) ─────────────

/** A queue persisted as one JSON file per ticket under `dir`. Good enough to be the
 *  real MVP async queue, and fully testable without any external service. */
export class LocalEscalationSink implements EscalationSink {
  readonly name = "local";
  constructor(private readonly dir: string) {}

  private pathOf(id: string): string {
    return join(this.dir, `${id}.json`);
  }
  private persist(t: EscalationTicket): EscalationTicket {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pathOf(t.id), JSON.stringify(t, null, 2));
    return t;
  }

  async open(packet: EscalationPacket, now: string = new Date().toISOString()): Promise<EscalationTicket> {
    const existing = await this.get(ticketId(packet));
    if (existing) return existing; // idempotent: re-queuing the same escalation is a no-op
    return this.persist(openTicket(packet, now));
  }
  async claim(id: string, reviewer: string, now: string = new Date().toISOString()): Promise<EscalationTicket> {
    const t = await this.require(id);
    return this.persist(claimTicket(t, reviewer, now));
  }
  async resolve(id: string, decisions: ReviewDecision[], now: string = new Date().toISOString()): Promise<EscalationTicket> {
    const t = await this.require(id);
    return this.persist(resolveTicket(t, decisions, now));
  }
  async get(id: string): Promise<EscalationTicket | null> {
    const p = this.pathOf(id);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as EscalationTicket;
    } catch {
      return null;
    }
  }
  async list(state?: TicketState): Promise<EscalationTicket[]> {
    if (!existsSync(this.dir)) return [];
    const out: EscalationTicket[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const t = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as EscalationTicket;
        if (!state || t.state === state) out.push(t);
      } catch {
        /* skip an unreadable/partial ticket file */
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async require(id: string): Promise<EscalationTicket> {
    const t = await this.get(id);
    if (!t) throw new Error(`no such ticket: ${id}`);
    return t;
  }
}
