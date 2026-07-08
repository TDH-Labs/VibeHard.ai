# VibeHard — roadmap notes (beyond the current product)

Durable notes for work that is **out of scope for the current VibeHard build** but
intentionally captured. The in-scope roadmap is `PROJECT_BRIEF.md` §15; this file is
for future products / spin-offs and deferred sub-features.

---

## Future product: the AI Maintainer (a SEPARATE product)

**What it is.** An AI that *maintains a deployed app over its life* — not just builds
it once. It watches production, proposes fixes/upgrades, and ships them safely:

```
deployed app emits logs / a new CVE lands
  → prod-feedback detects the anomaly (or depvuln flags the CVE)
  → AI proposes a fix (the auto-fix loop, triggered by a PROD signal, not a build)
  → the FULL gate chain re-runs on the fix (correct · secure · RLS · verify)
  → regression check against the spec's acceptance criteria (must not break what worked)
  → low-risk + all-green → ship (with instant rollback); risk/judgment → human (§24)
```

**Why it's a separate product, not a feature of this one.** Touching *production* is a
different risk class than gating a build: a bad build never shipped; a bad prod change
hits live users and their data now. It needs its own surface, its own trust posture,
and infrastructure this product doesn't have.

**What it REUSES from VibeHard (why we're uniquely positioned to build it):** the hard
part of "AI maintaining prod code" was never the edit — anyone can prompt an LLM to
change a repo. The hard part is letting it touch production *without breaking or leaking*.
That safety **is** VibeHard's deterministic spine, already built: the gate chain (the
safety check on every AI change), auto-fix (the fixer), prod-feedback §20 (the sensor),
refactor-phase §22 (the iron-rule revert), escalation §24 (judgment → human), and the
**spec + PRD acceptance criteria as the invariant** the maintenance must preserve.

**What it ADDITIONALLY needs (the real build, in rough order):**
1. **Regression coverage** — the crux. The gates prove *correct + secure + boots*, NOT
   *"every feature that worked yesterday still works."* Turn the PRD acceptance criteria
   into executable regression tests; generated apps have thin coverage today.
2. **Hosting + deploy/rollback automation** — canary/blue-green, instant revert (§15).
3. **The prod-feedback scheduler** — continuous scan cadence (§20 deferred).
4. **Trigger wiring** — a feedback packet auto-kicks a maintenance iteration.
5. **Stricter human-approval policy in prod** — anything touching auth / money / sensitive
   data goes through a human even when the deterministic checks are green.

**The boundary that must NOT move:** never an autonomous AI deploy to production without
the gates passing AND a human owning anything that's a judgment or a risk (§11 + §24,
held *harder* than at build). Positioning: "AI maintainer **with a human safety net**",
never "fully autonomous AI editing your production."

**Why it matters:** for the non-technical sensitive-data beachhead, "we keep it running
and secure after launch" is the other half of the value prop (they can't maintain it
themselves — the whole reason they need us), and the moat (gates + escalation network) is
worth more in prod, where the stakes and the recurring revenue both live.

---

## Phase II: Enterprise Agent Builder (the "Holy Grail" market gap)

**The Market Gap.** No single platform natively combines all three layers required for
non-technical founders to build AI-first Service-as-Software businesses:

1. **No-Code Builders** (MindStudio, Relevance AI, Aisera) have the SOP Compiler but no
   BYOC orchestrator — cannot route sensitive data through their servers (kills enterprise
   legal / healthcare deals).

2. **BYOC Infrastructure** (Nuon, Northflank, Porter) have the orchestrator but require
   DevOps engineers to hand them compiled Docker images — non-technical founders are locked out.

3. **Agent Frameworks** (LangGraph, CrewAI) have the runtime template but are just code
   libraries — still requires hiring senior Python developers.

**The Unfair Advantage.** VibeHard is uniquely positioned to bridge all three:

* **Agent Runtime Template** — standardized backend loop (CrewAI / LangGraph) running on
  Fly.io, configured (not coded) by the SOP Compiler.
* **SOP Compiler** — conversational UI that turns "what triggers the agent? what does it
  do? where does output go?" into a workflow config file.
* **BYOB Orchestrator** — already built. Multi-tenant, data-sovereign, customer-VPC
  deployment, full safety-gate chain, at scale.

**What gets unlocked.** The first **No-Code Enterprise Agent Builder** — ease-of-use of
MindStudio with the data-sovereignty and compliance of Northflank / Databricks. Non-technical
domain experts (e.g., 20-year logistics veterans) can build enterprise-ready, HIPAA/SOX/GDPR
Service-as-Software companies without raising $2M for a DevOps + engineering team.

**TAM.** Not just therapists + bookkeepers (the current beachhead): every knowledge-work
vertical is addressable. Medical MSOs, legal services, recruiting, call centers, financial
advising, tax prep, compliance — potentially 1M+ service professionals globally who have
domain expertise but no infrastructure to deliver AI-first services at enterprise scale.

**The Build (rough order):**
1. **Standardized Agent Runtime Template** — pre-built FastAPI + CrewAI/LangGraph loop that
   loads a workflow config; deploy to Fly.io via the existing orchestrator.
2. **Integration Hub** — pre-wired connectors (OAuth, MCP servers, token storage) for
   common integrations (Gmail, Slack, Stripe, etc.); user clicks "Connect," orchestrator
   handles the OAuth dance and wires tokens into the runtime.
3. **SOP Compiler** — conversational builder that interviews the user, generates workflow
   config + database schema, feeds both into provisioning.
4. **Compliance Scaffolding** — vertical-specific templates (medical → PHI isolation,
   legal → evidence handling, financial → PCI scope) with gates already tuned.

**Why VibeHard, not a new product.** The safety gates, deterministic spec → PRD →
architecture pipeline, RLS enforcement, and multi-tenant isolation are already load-bearing.
This is an adjacent surface on the same engine, not a rebuild.

---

## Deferred refactor surfaces (current product ships only the explicit whole-app pass)

The current build ships `vibehard refactor <dir>` — an explicit, operator-invoked,
whole-app pass on a passing build (iron rule: re-verify, revert on break). Deferred until
there's a reason (an account layer, automatic triggers, a traction signal):

- **Add-on entitlement gating** — `AND (refactor enabled)` at the trigger point; one build
  + a per-account flag (NOT two builds). Becomes real with the SaaS/account layer; the
  explicit command is the opt-in for now.
- **Slice-scoped refactor at gated reviews** — the reviewer's discretion, scoped to the
  escalated slice, after the fix, re-verified. (Whole-app stays the deliberate step.)
- **Traction-triggered refactor** — promote a "prototype" to a full pass once §20 shows
  real usage.
- **Auto-run inside `build` at production rigor** — intentionally NOT done; a senior
  refactors when it pays off (a human's in the slice / it's earned it), not speculatively
  on every build.

---

## Product storefront — marketing site + copy (TODO), and the hosted app UI

**TODO — marketing site (design + copy).** A public site that sells the product to the
non-technical, sensitive-data segment (clinics / legal / accounting): visual/brand design,
positioning, and website copy. Lead with the value prop — "build a real app for your
business, with the security built in and an expert on call" — not the engineering.
Translate the moat (enforced gates + on-demand human engineer) into operator language.
§16-BINDING on every word: never "HIPAA/SOC 2 compliant / certified" — "helps toward,
never certifies." Needs a design/brand pass + landing / pricing / trust-&-security pages.

**The hosted app UI (bigger, same "storefront" theme).** The product itself: a web app
where a non-technical user types a prompt and watches build → gate → ship, with the gates
HIDDEN (enforced FOR them, not shown TO them — §1/§16) and holds/escalations surfaced in
plain language. Today VibeHard is a CLI the target user can't operate; this UI is what
stands between the proven engine and a real customer.
