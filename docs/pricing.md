# VibeHard — pricing model (binding direction)

> **Rewritten 2026-07-03.** The previous version of this doc grounded the tiers in a Teladoc-style
> pooled human review ("an engineer on call, scoped reviews funded by the pool"). That layer is out
> of the product (Adam's direction: failing gates rely on the bounded fix loop and the HOLD, no
> human reviewer) — so the economics here are re-grounded in what the product actually sells and
> actually spends. Pairs with §16 (positioning / honest-copy). Live tier numbers are in
> `src/platform/plans.ts` and Stripe; this doc explains WHY they're shaped that way.
> All dollar figures are **planning assumptions to be replaced by measured data.**

## The model in one line
**Throughput pricing on a fixed-quality line.** Every tier runs the identical eleven-gate
inspection line — safety is never the paid axis (§16: charge for *more*, never for *safe*). What a
tier buys is **how much of the line you can use**: gated builds per day and concurrent projects.
The unit of cost, and therefore the unit of sale, is the **gated build**.

## What a gated build actually costs (the COGS model)
A gated build spends money in three places:

| Cost driver | What it is | Planning note |
|---|---|---|
| **LLM tokens** | ~12 pipeline stages (intake → spec → PRD → SRS → SAD → adversarial review → codegen across parallel workstreams → fix rounds → refactor/polish → functest) on OpenRouter (deepseek-v4-pro, kimi-k2.7-code) | The dominant, variable cost. **Fix rounds multiply it** — a build the loop has to repair 3× costs several times a clean pass. |
| **Sandbox compute** | Fly machines for the container/node/build verify gates (ephemeral, torn down per run) | Minutes per build; small but real, scales with fix rounds too. |
| **Hosting per live app** | Managed Supabase project + Fly hosting for each deployed app | ~$15–25/mo per *live* app (plan: $20) — a per-project cost, which is why tiers also cap projects. |

Two structural facts fall out of this:
1. **The fix loop is COGS, not a billable event.** A held build has usually consumed *more*
   compute than a clean pass (it ran the repair rounds and still didn't converge) and shipped
   nothing. That cost is carried by the plan — holding is baseline behavior, never a
   per-incident toll. This is the honest-copy line the site already takes.
2. **Builds/day and projects are the right meters** because they cap the two real cost axes:
   token+sandbox spend (per build) and hosting spend (per live project).

## The live tiers (shipped 2026-07-01, adjusted 2026-07-02)
| Tier | Price | Gated builds/day | Projects | Notes |
|---|---|---|---|---|
| **Free** | $0 | 2 | 1 | The demo that is the product — full line, no exceptions. Funnel cost, capped by the low quota. |
| **Starter** ⭐ | $39/mo | 5 | 5 | The default. Must clear COGS at realistic (not worst-case) utilization. |
| **Pro** | $199/mo | 20 | 25 | Heavier builders + BYO model key (which shifts token COGS to the customer entirely). |

**Margin logic:** price ≳ `(expected builds/mo × cost per gated build) + (live projects × hosting)`
with a target gross margin around 70%. Most subscribers use a fraction of their quota (standard
SaaS utilization curve) — the quota is a ceiling, not an expectation. BYO keys on Pro remove the
dominant cost driver for exactly the customers most likely to max the quota.

## The KPIs to instrument (these set the final prices)
| KPI | Why it's the number |
|---|---|
| **Cost per gated build** (tokens + sandbox, measured) | The unit economics keystone — replaces the old model's "escalation rate" as the one number everything keys off |
| **Fix rounds per build** (P50 / P95) | The multiplier on the keystone; also the generation-quality health metric (eval harness, EPIC #38) |
| **Quota utilization per tier** (builds used / quota) | Turns worst-case margin math into expected-case |
| **Live projects per account** | Drives the hosting line |
| **Gross margin per tier** | (revenue − tokens − sandbox − hosting) / revenue, target ~70% |

Until these are instrumented (EPIC #37 owns cost observability), treat the current prices as a
**conservative starting frame**: they were set low-quota enough that even pessimistic per-build
costs don't go underwater.

## Honest guardrails (unchanged in spirit, restated for the new model)
- **Charge for *more*, never for *safe*.** Every tier, the full line, the identical hold behavior.
  No tier ever buys a laxer check or a faster bypass.
- **No surprise bills.** Quotas gate cleanly ("new builds wait until tomorrow"), nothing meters
  mid-build, and a held build never generates a charge. Predictability is a selling point to a
  non-technical, anxiety-prone buyer — the category's known weakness is "credits ran out
  mid-project."
- **Control the anchor.** Never price against Lovable's $25; anchor against "a $30k agency build"
  and "what a leak would cost you." The reference price decides whether $199 reads as expensive.
- **No fake compliance badges** in any tier copy (§16 hard bans stand).
- **Price conservatively while the pool is small.** With few accounts, a handful of
  quota-maxing customers can distort COGS; the quotas are the protection. Loosen quotas before
  lowering prices.

## Retired (do not resurrect)
The Teladoc pooled-review frame, the $50 scoped-review unit, escalation-rate KPIs, reviewer
compensation, and any "Practice tier includes an engineer" pricing story. The doc that described
them lives in git history (pre-2026-07-03) if the strategy ever changes back.
