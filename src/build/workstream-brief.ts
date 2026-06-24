/**
 * Per-workstream codegen brief (PROJECT_BRIEF.md §22). The architecture is built tier by tier;
 * for each workstream the engine gets a SCOPED instruction — the overall plan, what's already
 * generated (so it builds on it), this workstream's slice (responsibility + files), and the
 * security NFRs. This is "the LLM codes inside each sub-task": one focused pass per component.
 *
 * It also threads the REVIEWED design into the build so what's gated is what's generated: the
 * SRS functional requirements this component implements (their exact I/O contracts, logic, and
 * error states) and the SAD's data schema (the exact DDL + RLS policies). Pure — a function of
 * the architecture (which carries the SRS) + which workstreams came before.
 */
import type { Architecture, Workstream } from "../architecture/index.ts";

export function workstreamBrief(arch: Architecture, ws: Workstream, priorWorkstreams: string[]): string {
  const spec = arch.prd.spec;
  const out: string[] = [];
  out.push(`We are building "${spec.name}" — ${spec.summary}`);
  out.push(`Stack: ${arch.stack}. Tenancy: ${spec.tenancy}. Auth: ${spec.auth}.`);
  if (arch.dataFlow) out.push(`Communication: ${arch.dataFlow}`);
  out.push("");
  out.push(
    `Architecture (all workstreams): ${arch.workstreams
      .map((w) => w.name + (w.dependsOn.length ? ` (needs: ${w.dependsOn.join(", ")})` : ""))
      .join("; ")}`,
    "",
  );
  if (priorWorkstreams.length) {
    out.push(`Already generated — their files exist in the project; build ON them, do not recreate them: ${priorWorkstreams.join(", ")}.`, "");
  }
  out.push(`NOW generate ONLY the "${ws.name}" workstream — ${ws.responsibility}.`);
  out.push(`Files to create: ${ws.files.join(", ")}.`, "");

  // The exact requirements this component implements (from the SRS) — implement the contract, don't re-invent it.
  const coveredFrs = arch.srs ? arch.srs.functionalRequirements.filter((fr) => ws.covers.includes(fr.id)) : [];
  if (coveredFrs.length) {
    out.push("This component MUST implement these specified requirements exactly (from the SRS):");
    for (const fr of coveredFrs) {
      out.push(`• ${fr.id} — ${fr.title}${fr.description ? `: ${fr.description}` : ""}`);
      if (fr.inputs.length) out.push(`    inputs: ${fr.inputs.map((i) => `${i.element} (${i.type}${i.constraints ? `, ${i.constraints}` : ""})`).join("; ")}`);
      if (fr.outputs.length) out.push(`    outputs: ${fr.outputs.map((o) => `${o.element} (${o.type})`).join("; ")}`);
      if (fr.workflow.length) out.push(`    logic: ${fr.workflow.join(" → ")}`);
      if (fr.errors.length) out.push(`    errors: ${fr.errors.map((e) => `${e.condition} → ${e.response}`).join("; ")}`);
    }
    out.push("");
  }

  // The exact data schema (from the SAD) — the migration workstream implements it; others reference it.
  if (arch.dataArchitecture.schema.trim()) {
    const ownsSchema = ws.files.some((f) => /\.sql$|migration/i.test(f));
    out.push(
      ownsSchema
        ? "Implement THIS EXACT database schema as the migration (tables, columns, and the Row-Level Security policies — the reviewed design):"
        : "Reference — the database schema (owned by the migration workstream); write your queries against these exact tables and columns:",
    );
    out.push("```sql", arch.dataArchitecture.schema.trim(), "```", "");
  }

  if (arch.prd.nfrs.length) {
    out.push("SECURITY REQUIREMENTS (mandatory — checked by automated gates after the build):");
    for (const n of arch.prd.nfrs) out.push(`- ${n}`);
    out.push("");
  }
  out.push("Output only the files for this workstream.");
  return out.join("\n");
}
