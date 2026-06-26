/**
 * Deterministic DASHBOARD/overview generator (roadmap Phase 2). From the DataModel, emit a landing
 * `/dashboard` page with KPI cards (a live row-count per key entity) and a "recent items" panel —
 * the at-a-glance home that made Base44 feel like a product and our bare list feel unfinished. The
 * generated backend's signin route already lands on `/dashboard`, so this is the post-login home.
 * Uses the scaffolded design-system classes (.card etc.) so it inherits the premium look for free.
 * Generate-then-own.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DataModel, Entity } from "./model.ts";

const MARKER = "@vibehard:generated";

function writeOwned(path: string, content: string): boolean {
  if (existsSync(path)) {
    try {
      if (!readFileSync(path, "utf8").includes(MARKER)) return false;
    } catch {
      return false;
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

const title = (s: string): string => s.replace(/([a-z])([A-Z])/g, "$1 $2");
const IRREGULAR: Record<string, string> = { child: "children", person: "people", staff: "staff", datum: "data" };
/** Pluralize an entity label for headings/cards (Child → Children, Category → Categories). */
function plural(word: string): string {
  const w = title(word);
  const low = w.toLowerCase();
  if (IRREGULAR[low]) return w.slice(0, w.length - low.length) + IRREGULAR[low];
  if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + "ies";
  if (/(s|x|z|ch|sh)$/i.test(w)) return w + "es";
  return w + "s";
}
/** A human label field for "recent items": prefer name, else the first plain text column, else id. */
function labelField(e: Entity): string {
  return e.fields.find((f) => f.name.toLowerCase() === "name")?.name ?? e.fields.find((f) => f.type === "text" && !f.references)?.name ?? "id";
}

function dashboardPage(model: DataModel): string {
  // KPI entities: the feature tables (not the tenant root or the membership table), up to 4.
  const kpis = model.entities.filter((e) => e.name !== model.tenantEntity && e.name !== model.membershipEntity).slice(0, 4);
  const recent = kpis[0];
  const counts = kpis.map((e) => `    supabase.from(${JSON.stringify(e.name)}).select('*', { count: 'exact', head: true })`).join(",\n");
  const cards = kpis
    .map(
      (e, i) => `        <div className="card p-5">
          <p className="text-2xl font-semibold text-slate-900">{c${i}.count ?? 0}</p>
          <p className="text-sm text-slate-500">${plural(e.name)}</p>
        </div>`,
    )
    .join("\n");

  return `// ${MARKER}
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

export const metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const supabase = await createClient();
  const [${kpis.map((_, i) => `c${i}`).join(", ")}${recent ? ", recent" : ""}] = await Promise.all([
${counts}${
    recent
      ? `,
    supabase.from(${JSON.stringify(recent.name)}).select('*').order('createdAt', { ascending: false }).limit(5)`
      : ""
  }
  ]);

  return (
    <main className="mx-auto max-w-5xl p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Good day 👋</h1>
        <p className="mt-1 text-sm text-slate-500">Here&apos;s what&apos;s happening today.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
${cards}
      </div>${
        recent
          ? `
      <section className="card p-5">
        <h2 className="text-base font-semibold text-slate-900">Recent ${plural(recent.name).toLowerCase()}</h2>
        {(recent.data ?? []).length === 0 ? (
          <p className="mt-4 text-sm text-slate-400">Nothing yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {(recent.data ?? []).map((row: Record<string, unknown>) => (
              <li key={String(row.id)} className="py-2.5 text-sm text-slate-900">{String(row[${JSON.stringify(labelField(recent))}] ?? row.id)}</li>
            ))}
          </ul>
        )}
      </section>`
          : ""
      }
      <p className="text-xs text-slate-400">Signed in. <Link href="/login" className="text-accent hover:underline">Switch account</Link></p>
    </main>
  );
}
`;
}

export interface DashboardResult {
  written: boolean;
  rel: string;
}

export function generateDashboard(target: string, model: DataModel): DashboardResult {
  const rel = "app/dashboard/page.tsx";
  // Only meaningful when there are feature entities to summarize.
  const hasFeature = model.entities.some((e) => e.name !== model.tenantEntity && e.name !== model.membershipEntity);
  if (!hasFeature) return { written: false, rel };
  return { written: writeOwned(join(target, rel), dashboardPage(model)), rel };
}

export const _internalDash = { dashboardPage, labelField };
