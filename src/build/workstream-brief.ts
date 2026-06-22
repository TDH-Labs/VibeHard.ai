/**
 * Per-workstream codegen brief (PROJECT_BRIEF.md §22). The architecture is built
 * tier by tier; for each workstream the engine gets a SCOPED instruction — the
 * overall plan, what's already generated (so it builds on it), this workstream's
 * slice (responsibility + files), and the security NFRs. This is "the LLM codes
 * inside each sub-task": one focused pass per component instead of one giant prompt.
 * Pure — a function of the architecture + which workstreams came before.
 */
import type { Architecture, Workstream } from "../architecture/index.ts";

export function workstreamBrief(arch: Architecture, ws: Workstream, priorWorkstreams: string[]): string {
  const spec = arch.prd.spec;
  const out: string[] = [];
  out.push(`We are building "${spec.name}" — ${spec.summary}`);
  out.push(`Stack: ${arch.stack}. Tenancy: ${spec.tenancy}. Auth: ${spec.auth}.`, "");
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
  if (arch.prd.nfrs.length) {
    out.push("SECURITY REQUIREMENTS (mandatory — checked by automated gates after the build):");
    for (const n of arch.prd.nfrs) out.push(`- ${n}`);
    out.push("");
  }
  out.push("Output only the files for this workstream.");
  return out.join("\n");
}
