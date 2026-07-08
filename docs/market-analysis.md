# Three markets, one engine — a realistic assessment

_2026-07-08. Companion to `ROADMAP.md` → "Phase II: Enterprise Agent Builder". This is the
honest read on which of the three product directions to lead with, written to be re-read
before any GTM or build-priority decision._

## The three directions

1. **VibeHard.ai** — SMBs building apps for themselves (current live product; beachhead =
   sensitive-data verticals: therapists, bookkeepers).
2. **The orchestrator** — the BYOB deployment engine (multi-tenant provisioning, safety
   gates, customer-owned Supabase/Stripe) sold to other builders/agencies; the direct
   comparison is InsForge, with BYOC players (Nuon, Northflank, Porter) adjacent.
3. **Service-as-Software infrastructure** — the Phase II Enterprise Agent Builder: Agent
   Runtime Template + SOP Compiler + Integration Hub on top of the orchestrator, so
   non-technical domain experts can launch AI-first service businesses.

## Market data (as of July 2026)

- **No-code AI platforms** (market 1): ~$8.6B in 2026 growing ~31%/yr toward ~$75B by 2034
  (Fortune Business Insights). Crowded and brutally capitalized: Lovable, Bolt, Replit, v0;
  Base44 already exited to Wix.
- **BaaS / developer infrastructure** (market 2): the most proven revenue pool today.
  Supabase: $70M ARR, ~250–300% YoY, $5B valuation, ~28% BaaS share (Sacra); Firebase still
  the incumbent.
- **AI agents / Service-as-Software** (market 3): fastest growing — ~$7.6B (2025) → ~$10.9B
  (2026), ~45% YoY, toward ~$50B by 2030. YC's thesis: vertical AI agents could be 10x
  bigger than SaaS ($300B+ of company value); a16z sizes vertical SaaS at ~$450B with
  30–40% reshaped by agents in 2026–2028.

## The verdict

| Question | Answer |
|---|---|
| Biggest today | Market 2 (BaaS) — proven revenue, but hardest to enter |
| Fastest growing | Market 3 (~45% YoY) |
| Biggest eventually | Market 3 — selling completed work, not seats |
| Strongest immediate position | Market 1 is live and earning learning; market 3 is where the built assets (gates, BYOB, isolation, compliance posture) map to unmet demand |

**Can we realistically compete?**

- **Market 1: not head-on; yes in the niche.** The consumer/SMB app-builder space is a kill
  zone of nine-figure war chests. The defensible slice is the sensitive-data SMB niche where
  enforced gates genuinely matter — a niche within the market, not the market.
- **Market 2: no.** Developer infrastructure is won with free tiers, community, ecosystem
  maturity, and years of accumulated trust. BYOB is a real differentiator but not enough to
  close the ecosystem gap against Supabase/InsForge as a standalone dev-tools GTM.
- **Market 3: yes, for now.** The incumbents are siloed (no-code builders lack BYOC
  sovereignty; BYOC infra demands DevOps teams; agent frameworks are bare libraries) and the
  hard part — the safe multi-tenant deployment engine with deterministic gates — is already
  built here. The window is real but not permanent: MindStudio adding BYOC, or Northflank
  adding no-code, closes it. Working estimate: 12–24 months.

## The strategy: one engine, one flagship GTM

- **Keep VibeHard.ai alive** as the revenue-and-learning beachhead. It exists, it exercises
  the engine end-to-end, and every build hardens the gates.
- **Build Phase II (Agent Runtime + SOP Compiler + Integration Hub) as THE strategic bet** —
  see `ROADMAP.md` Phase II for the build order.
- **Do not launch a standalone orchestrator GTM.** Sell the orchestrator as the deployment
  layer inside market 3, and opportunistically to agencies who ask. Three GTMs solo = zero
  GTMs done well.

## Sources

- Fortune Business Insights, no-code AI platform market: https://www.fortunebusinessinsights.com/no-code-ai-platform-market-110382
- Sacra, Supabase ARR/valuation: https://sacra.com/research/supabase-at-70m-arr-growing-250-yoy/
- Y Combinator, "Vertical AI Agents Could Be 10X Bigger Than SaaS": https://www.ycombinator.com/library/Lt-vertical-ai-agents-could-be-10x-bigger-than-saas
- 8seneca, vertical AI agents enterprise 2026 (agents market sizing): https://www.8seneca.com/en/blog/technology/vertical-ai-agents-enterprise-2026
