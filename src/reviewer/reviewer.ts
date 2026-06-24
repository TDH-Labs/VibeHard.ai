/**
 * Reviewer registry (backlog #3, docs/specs/reviewer-moat.md). The human half of the moat:
 * an SWE reviewer with declared SPECIALTIES who can claim escalation packets routed to those
 * specialties. Identity + persistence mirror FileTenantStore; the matching rule (which reviewer
 * may take which packet) is pure, deterministic code — the routing moat. The human supplies the
 * judgment; this decides only who is QUALIFIED to supply it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EscalationPacket } from "../escalation/packet.ts";
import { isSpecialty, type Specialty } from "../escalation/routing.ts";

export interface Reviewer {
  id: string;
  name: string;
  specialties: Specialty[]; // what this reviewer is qualified to judge
  status: "active" | "inactive";
  createdAt: string;
}

/** Validate raw specialty inputs against the closed set. Empty input → ["general"] (a generalist).
 *  Unknown values are reported (never silently dropped). Deduped, order-preserving. Pure. */
export function parseSpecialties(raw: string[]): { specialties: Specialty[]; invalid: string[] } {
  const specialties: Specialty[] = [];
  const invalid: string[] = [];
  for (const r of raw) {
    const s = r.trim().toLowerCase();
    if (!s) continue;
    if (isSpecialty(s)) {
      if (!specialties.includes(s)) specialties.push(s);
    } else {
      invalid.push(r);
    }
  }
  if (!specialties.length && !invalid.length) specialties.push("general");
  return { specialties, invalid };
}

const safeSlug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "reviewer";

/** Build a reviewer record. id is a slug of the name (stable, human-readable). Pure. */
export function makeReviewer(name: string, specialties: Specialty[], now: string): Reviewer {
  return { id: `rev-${safeSlug(name)}`, name: name.trim(), specialties, status: "active", createdAt: now };
}

/** Pure routing moat: may this reviewer claim this packet? An ACTIVE reviewer whose specialties
 *  intersect the packet's required specialties. No overlap (or inactive) → not qualified. */
export function matchesPacket(reviewer: Reviewer, packet: EscalationPacket): boolean {
  if (reviewer.status !== "active") return false;
  // Fail-closed: a packet with no required specialties is a routing bug — nobody is "qualified"
  // for an unrouted packet, so we never let it be claimed on a vacuous match.
  if (!packet.specialties.length) return false;
  return packet.specialties.some((s) => reviewer.specialties.includes(s));
}

export interface ReviewerStore {
  create(reviewer: Reviewer): void;
  get(id: string): Reviewer | null;
  list(): Reviewer[];
  update(reviewer: Reviewer): void;
}

/** One JSON file per reviewer under `dir` (mirrors FileTenantStore). A platform DB drops in
 *  behind the ReviewerStore seam later. */
export class FileReviewerStore implements ReviewerStore {
  constructor(private readonly dir: string) {}

  private path(id: string): string {
    return join(this.dir, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  }

  create(reviewer: Reviewer): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    if (existsSync(this.path(reviewer.id))) throw new Error(`reviewer ${reviewer.id} already exists`);
    writeFileSync(this.path(reviewer.id), JSON.stringify(reviewer, null, 2));
  }

  get(id: string): Reviewer | null {
    const p = this.path(id);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as Reviewer;
    } catch {
      return null;
    }
  }

  list(): Reviewer[] {
    if (!existsSync(this.dir)) return [];
    const out: Reviewer[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Reviewer);
      } catch {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  update(reviewer: Reviewer): void {
    if (!existsSync(this.path(reviewer.id))) throw new Error(`reviewer ${reviewer.id} not found`);
    writeFileSync(this.path(reviewer.id), JSON.stringify(reviewer, null, 2));
  }
}
