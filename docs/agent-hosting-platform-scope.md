# Agent-hosting platform — v1.0 scope (Buzz + Goose only)

Status: scoping draft, 2026-07-23. Not started. Written after researching Buzz (block/buzz,
launched 2026-07-21) and Goose (block/goose, Linux Foundation AAIF) — this is grounded in their
actual documented architecture, not assumption.

## The key finding: this is smaller than it looked

Buzz and Goose already provide almost everything the "hard part" (agent identity, persona,
harness integration, scriptable control) needs. VibeHard's job is narrower than "build an
agent-hosting platform from scratch" — it's "build the customer-facing control plane on top of
infrastructure Block already built and open-sourced."

### What Buzz already provides
- **Identity**: every agent gets its own Nostr keypair — "added to a channel the same way you
  add a person." Not a bot token bolted onto an API; a first-class member with its own channel
  memberships and audit trail.
- **Persona**: `buzz-persona` — agent persona packs are a native primitive, not something we'd
  invent. The wizard's "personality" question maps directly onto authoring one of these.
- **Harness integration**: `buzz-acp` — an ACP (agent protocol) harness that ALREADY wraps
  Goose (also Codex, Claude Code) to speak Buzz's protocol. We do not need to write the
  Goose↔Buzz integration; Block did.
- **Scriptable control**: `buzz-cli` — "agent-first CLI, JSON in / JSON out." This is what
  VibeHard's generated backend calls to provision identities, channel memberships, etc. —
  not a raw Nostr-protocol integration.
- **Workflow automation**: `buzz-workflow` — YAML automation, likely relevant to "skills."
- **Hosting**: self-host (Apache-2.0, github.com/block/buzz) or managed via buzz.xyz. v1
  should target the managed option — no reason to operate Nostr relay infrastructure ourselves
  for a v1.

### What Goose already provides
- Open-source (Apache-2.0, Rust, cross-platform), MCP-based extensions (70+ maintained, any MCP
  server attachable), 15+ LLM providers.
- A **recipe** system — a declarative config (persona/instructions, extensions, model/provider)
  that reportedly scaled Goose to 60% internal usage at Block via recipe reuse. This is the
  detail that makes this VibeHard-shaped: the wizard's answers (persona, skills, model,
  provider) become a **generated recipe file**, not LLM-improvised runtime code. Same
  "structured data model → deterministic generation" pattern VibeHard already uses for its own
  Supabase backend — just applied to a Goose recipe instead of a SQL migration.

### The one real gap: long-lived compute

Goose's documented deployment story is local (CLI/desktop) — no documented container/hosted
mode. Someone has to actually run `goose` (via `buzz-acp`) continuously, per customer agent,
connected with the right recipe + identity + Buzz channel membership.

**This must NOT reuse VibeHard's own E2B sandbox infrastructure** — that's built for ephemeral
build jobs, hard-capped at 1 hour by E2B's own API (confirmed live, this exact session). An
always-on customer agent needs a genuinely persistent process. Recommend **Fly Machines**
instead — VibeHard's platform already runs on Fly, already has the tooling/credentials/
experience, and Fly Machines are designed for exactly this (fast-booting, can stay up
indefinitely, unlike an E2B build sandbox).

## Proposed v1.0 architecture

**One runtime only: Goose.** Defer Hermes/NanoClaw/OpenClaw to a future iteration entirely —
don't build an abstraction layer for multiple harnesses until a second one is actually needed.

1. **Customer portal** (the VibeHard-generated Next.js+Supabase app):
   - Signup, billing (Stripe, metered per hosted agent)
   - Agent-configuration wizard: persona → a `buzz-persona` pack; skills/tools → Goose
     extensions (MCP servers) to attach; model/provider → Goose recipe's model config; channel
     → which Buzz workspace/channel(s) to join
   - Command center: list of the account's agents + status; chief-of-staff designation
   - This part is a normal, fully-functional CRUD+billing app — nothing here needs new
     platform infrastructure.

2. **Agent lifecycle backend** (the genuinely new platform capability):
   - On "create agent": generate a Goose recipe from the wizard's answers (deterministic
     templating, not LLM-generated) → provision a Nostr identity + persona pack in the
     customer's Buzz workspace via `buzz-cli` → provision a Fly Machine running `buzz-acp` +
     `goose --recipe <generated file>`, wired to that identity → track it for billing.
   - Start/stop/restart/delete controls, mirroring VibeHard's own build-worker lifecycle
     patterns (heartbeat, orphan sweep, checkpointing) — this session's own hardening of
     exactly that system tonight is directly reusable design experience, not a coincidence.

3. **Token-burn governance** (the user's explicit requirement): default new multi-agent
   accounts to **hub-and-spoke** — every inter-agent message routes through the chief-of-staff
   agent, not full mesh. This isn't just a UX nudge; it's the actual mechanism that bounds
   spend (N spokes vs. N² mesh). Full mesh can be an opt-in "advanced" setting with its own,
   more visible spend cap.

4. **Pricing lever for simplicity** (the user's explicit ask): price by underlying compute, not
   by an artificial nudge. **N agents sharing one Fly Machine process** (one harness holding
   several Buzz identities/recipes, dispatching by which identity a message targets) costs the
   platform less than **N agents each on their own isolated Machine** — pass that difference
   through directly. This is an honest cost-based incentive toward the "one shared runtime"
   option, not a made-up discount.

## Explicitly out of scope for v1.0

- Hermes, NanoClaw, OpenClaw, or any runtime other than Goose
- Self-hosting Buzz (v1 uses buzz.xyz managed hosting)
- Full-mesh inter-agent communication as the default (available, but opt-in)
- Anything requiring VibeHard's own E2B build-sandbox infrastructure to change — this needs a
  parallel, new "long-lived compute" capability (Fly Machines), not a modification of the
  build-time sandbox path

## Open questions before real design work starts

- `buzz-acp`'s exact protocol/config surface for wrapping Goose isn't in the pages fetched
  tonight — need to read `github.com/block/buzz`'s `ARCHITECTURE.md` and `buzz-acp`'s own docs
  directly before committing to an implementation plan.
- Goose's recipe YAML schema wasn't retrievable tonight (docs page 404'd) — need the real
  schema before recipe-generation code can be written.
- Whether buzz.xyz's managed hosting exposes the provisioning primitives (channel membership,
  persona assignment) via a documented API vs. `buzz-cli` requiring shell access on a machine
  that's also a Buzz relay participant — affects whether the Fly Machine per (shared-)agent
  process also needs to run `buzz-cli` locally, or whether the portal backend can call a REST
  API directly.

## Recommended next step

Not more research from search summaries — clone `block/buzz` and `block/goose`, read
`ARCHITECTURE.md` and the recipe schema directly, and prototype the recipe-generation +
`buzz-cli` provisioning path against a real (free) buzz.xyz account before writing any
VibeHard-side codegen for this.
