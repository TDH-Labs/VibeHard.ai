# Agent-hosting v1 — verified external contracts

Status: verified 2026-07-23 against shallow clones of block/buzz + block/goose
(`~/dev/reference/`), the installed goose 1.36.0 CLI, locally-built buzz binaries
(Rust 1.95.0, the repo's pinned toolchain), and the LIVE managed relay at
`onboarding.communities.buzz.xyz` (v0.2.0). Every claim below was exercised, not
summarized from search. This document is the review baseline for the generator and
lifecycle code — if implementation and this doc disagree, one of them is wrong and
the disagreement must be resolved, not papered over.

## Corrections to the scoping doc (load-bearing)

1. **Goose recipes are NOT the integration point.** `goose acp` accepts exactly one
   option, `--with-builtin <NAME>` (verified in `goose-cli/src/cli.rs` AND on the
   installed binary). No `--recipe`, no system-prompt flag. The deterministic
   artifact the wizard generates is a **Buzz persona pack**, not a recipe file.
   Recipes remain real (`crates/goose/src/recipe/mod.rs`) but are unreachable in
   ACP mode — do not build a recipe generator for v1.
2. **The env contract is `BUZZ_PRIVATE_KEY` + `BUZZ_RELAY_URL` (+ optional
   `BUZZ_API_TOKEN`).** There is no `BUZZ_AUTH_TAG` anywhere in the codebase — that
   variable name from prior research does not exist.
3. **"No announced usage limits" is no longer accurate.** The managed relay
   advertises NIP-11 limitations (below) and its ops docs record a live
   "rate-limited: quota exceeded" incident (2026-07-17) on this exact relay.
   Quotas are real even though pricing isn't announced.

## Managed relay (buzz.xyz) — live probe results

- `https://onboarding.communities.buzz.xyz` is up; `/health` → 200; NIP-11 info:
  `version 0.2.0`, `auth_required: true`, `payment_required: false`,
  `restricted_writes: true`. Communities are hosted per-subdomain
  (`{community}.communities.buzz.xyz`); the URL IS the workspace boundary
  (multi-tenant formal spec: `docs/multi-tenant-relay.md`).
- Advertised limits: max_subscriptions 1024, max_filters 10, max_limit 10000,
  max_message_length 524288, plus push-lease quotas (max_leases_per_pubkey 16 …).
- buzz.xyz itself is a bare early-access landing page ("Come test the early stages
  with us") — **no self-serve signup, no pricing page**. Getting a community +
  membership is human/invite-gated. → OPEN ITEM for Adam: acquire a community on
  buzz.xyz (or an invite into one) before the provisioning path can be exercised
  beyond the 403 boundary below.
- Live probe with a freshly minted keypair:
  `buzz channels list` → `{"error":"auth_error","message":"relay error 403:
  relay_membership_required"}`, exit 3. The NIP-98 signing path, env contract, and
  relay auth layer all work; membership is the only missing ingredient.

## Identity + provisioning

- Identity = secp256k1 Nostr keypair. Minted locally: `buzz-admin generate-key`
  (prints hex public/secret to stdout — CAPTURE TO FILE, never echo; treat like any
  secret). `buzz-admin mint-token --name --scopes` additionally mints a scoped API
  token (shown once).
- Relay membership is operator-controlled (`buzz-admin add-member`, kind:13534
  roster) — on managed hosting this is Block's side or a community-admin surface,
  NOT our platform's. Our backend provisions *channel* membership via `buzz`
  (buzz-cli): `channels create/join/add-member`, once our identity is a community
  member.
- buzz-cli: JSON stdout, JSON errors on stderr, exit codes 0/1/2/3/4/5
  (ok/user/network/auth/other/write-conflict) — verified live (3 on auth).

## Persona pack (the artifact our generator emits)

Spec: `crates/buzz-persona/PERSONA_PACK_SPEC.md` (v: current flat-frontmatter
format; the V6 `buzz:`-namespaced format is dead). Minimal valid pack (verified
with the real `buzz pack validate` — "Valid.", exit 0):

```
pack/
├── .plugin/plugin.json     # OPS manifest + personas[] + defaults{}
├── agents/<name>.persona.md # YAML frontmatter + markdown persona prompt
└── skills/<skill>/SKILL.md  # name: + description: REQUIRED or silently skipped
```

- Frontmatter unknown keys are HARD errors (`deny_unknown_fields`) — the generator
  must emit exactly the schema fields: name, display_name, description, version,
  author, skills, mcp_servers, subscribe, triggers{mentions,keywords,all_messages},
  model ("provider:model-id"), temperature, max_context_tokens, thread_replies,
  broadcast_replies, hooks.
- `buzz pack inspect` confirms the resolved env projection literally:
  `model: "anthropic:claude-sonnet-4-20250514"` →
  `GOOSE_PROVIDER=anthropic, GOOSE_MODEL=claude-sonnet-4-20250514`,
  `temperature` → `GOOSE_TEMPERATURE`, `max_context_tokens` → `GOOSE_CONTEXT_LIMIT`.
  Injected per-subprocess by buzz-acp (`extra_env`); operator env vars win
  (precedence level 1) — so the Fly Machine env must NOT set GOOSE_* globally when
  running multiple personas, or every persona gets the same model.
- Merge semantics: shallow replacement only (persona field replaces pack default
  entirely; `null` = fall through, `[]`/`{}` = deliberate override).
- MCP servers: stdio or streamable_http ONLY (SSE rejected at session start).
  Delivered via ACP `NewSessionRequest.mcp_servers` — never written to disk.
  `${VAR}` interpolation in MCP env is NOT yet implemented (passes through
  literally) — do not rely on it for secrets yet.
- Skills are copied to `$AGENT_CWD/.agents/skills/` (copy step "planned" per spec —
  verify at integration time whether our harness version does it; if not, our
  Machine bootstrap must place skills there itself).
- Hooks: parsed/validated but NOT executed yet. Do not build on hooks for v1.
- Persona prompt is delivered as a `[System]` prefix on every user message (true
  system-prompt injection is planned, not shipped).

## buzz-acp (the process our Fly Machine runs, per agent identity)

- Spawns `goose acp` by default (`BUZZ_ACP_AGENT_COMMAND=goose`,
  `BUZZ_ACP_AGENT_ARGS=acp`). Core env: `BUZZ_PRIVATE_KEY` (required),
  `BUZZ_RELAY_URL`, `BUZZ_API_TOKEN` (if relay enforces tokens),
  `BUZZ_ACP_IDLE_TIMEOUT` (620s default), `BUZZ_ACP_MAX_TURN_DURATION` (7200s).
- **`--agents N` (1–32) = ONE shared identity with N worker subprocesses**, not N
  agents. Our "N customer agents share one Machine" pricing tier therefore means
  N buzz-acp PROCESSES (one per identity/persona) on one Machine — not one
  buzz-acp with --agents N.
- Author gate: `--respond-to` defaults to `owner-only` via registered
  `agent_owner_pubkey`; owner control commands `!shutdown` / `!cancel` / `!rotate`
  work regardless of gate. Map the customer's own pubkey to the agent's owner.
- `--heartbeat-interval` (≥10s or 0) gives always-on agents periodic self-prompts —
  the hub-and-spoke chief-of-staff's pulse. At most one heartbeat in flight;
  skipped under load.
- Crash recovery (agent respawn) and relay reconnect (`since` replay) are built in —
  our Machine supervisor only needs to keep buzz-acp itself alive.

## Compute sizing note (for AHP-4)

buzz-acp + goose are two lightweight processes; memory scales ~N × (goose + MCP
servers). The 1-hour cap that disqualified E2B does not exist on Fly Machines.
Shared-machine tier = multiple buzz-acp processes under one supervisor on one
Machine; isolated tier = one Machine per identity. Cost pass-through prices the
difference directly.
