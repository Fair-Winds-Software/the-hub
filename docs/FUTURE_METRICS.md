# Future Metrics — What HUB Could Measure Next

Companion doc to the Dashboard `BiTileCluster`. Lists SaaS KPIs that HUB does
**not** currently compute, grouped by what data would need to flow into HUB
before the tile could be built.

The current Tier-1 tiles (Total MRR, ARR, Revenue Growth 30d, ARPA, CLV,
Active Customers, Portfolio DAU, Portfolio Churn) are all derivable from the
`metric_rollups` table given products push `mrr_cents`, `active_customers`,
`daily_active_users`, and `churn_rate` events into
`POST /api/v1/admin/bi/metrics`.

---

## Tier 2 — Pipeline exists, needs product-side push

These metrics can be added to the BI cluster with **no HUB code changes** once
products start ingesting the required events. Each row lists what event a
product would need to send (metric name + shape) via the existing metric
ingestion endpoint.

| Metric | Formula | Required events (metric_name / dimensions) |
|---|---|---|
| **NRR (Net Revenue Retention)** | `(start_MRR + expansion + upgrade − downgrade − churn) / start_MRR` | `mrr_expansion_cents`, `mrr_upgrade_cents`, `mrr_downgrade_cents`, `mrr_churn_cents` (each keyed by tenant) |
| **Quick Ratio** | `(new_MRR + expansion_MRR) / (downgrade_MRR + churn_MRR)` | Same set as NRR |
| **Revenue Churn (gross)** | `revenue_lost / start_revenue` | `mrr_churn_cents` + snapshot of period-start MRR |
| **Revenue Churn (net)** | `(revenue_lost − upgrade_revenue) / start_revenue` | Add `mrr_upgrade_cents` |
| **WAU (Weekly Active Users)** | `SUM(unique_users over 7d)` | New catalog metric `weekly_active_users` (int, rollup=sum) |
| **MAU (Monthly Active Users)** | `SUM(unique_users over 30d)` | New catalog metric `monthly_active_users` (int, rollup=sum) |
| **DAU:MAU stickiness ratio** | `DAU / MAU` | Uses existing `daily_active_users` + new `monthly_active_users` |
| **Conversion Rate (freemium → paid)** | `(new_paid ÷ freemium_pool) × 100` | New catalog metrics: `freemium_users` (int, last), `new_paid_conversions` (int, sum) |
| **Retention Rate** | `1 − churn_rate` — already trivially derivable | Push existing `churn_rate` (already in catalog) |
| **Viral Growth Coefficient** | `invites_sent × conversion_rate / 100` | New catalog metrics: `referral_invites_sent` (int, sum), `referral_conversions` (int, sum) |
| **Feature Adoption (per feature)** | `active_users_in_feature ÷ DAU` | Already in catalog — `feature_adoption` (float, avg, dimension=`feature`). No new work — just needs producers. |

**Estimated work when data starts flowing:** one PR to `metricCatalog.ts` per
new event type + one PR per tile to `BiTileCluster.tsx`. No new services.

---

## Tier 3 — Needs external integration or manual entry

These metrics cannot be derived from anything HUB has today. They require
HUB to talk to a CRM, a support desk, an ad platform, an accounting ledger,
or a survey tool. Ownership will live under **HUB-1549 (LaunchKit ↔ HUB
Integration)** or a new HUB Integrations wave.

### CRM (deals, pipeline, sales activity)

Candidate systems: HubSpot, Salesforce, Pipedrive, Attio, Close, Copper.

| Metric | Formula | External data needed |
|---|---|---|
| **CAC (Customer Acquisition Cost)** | `(sales_spend + marketing_spend) / new_customers` | Marketing platform ad spend; CRM sales-team salary allocation |
| **CAC Payback Period** | `CAC ÷ (ARPA × gross_margin)` | CAC (above) + margin from accounting |
| **LTV:CAC Ratio** | `CLV ÷ CAC` | CLV from Tier 1 + CAC (above) |
| **Sales Cycle Length** | `mean(closed_at − first_touch_at)` | CRM deal lifecycle timestamps |
| **Lead-to-Opportunity Rate** | `qualified_opportunities ÷ leads_created` | CRM lead + opportunity records |
| **Opportunity-to-Close Rate** | `deals_won ÷ opportunities_created` | CRM opportunity + deal stage transitions |
| **Sales Pipeline Value** | `SUM(open_deal_value)` | CRM open-deal snapshot |
| **Pipeline Velocity** | `(deals × avg_value × win_rate) ÷ cycle_length_days` | Composite of the above |
| **Win Rate** | `deals_won ÷ (deals_won + deals_lost)` | CRM closed-deal outcomes |
| **Quote-to-Close Ratio** | `deals_closed ÷ quotes_sent` | HUB Custom Quotes system (`/console/billing/quotes`) already tracks quotes — integrate with CRM close data |
| **Sales per Rep** | `revenue ÷ rep_count` | CRM owner attribution + rep roster |
| **Sales by Region** | `SUM(revenue) GROUP BY region` | CRM territory field or customer address |
| **Sales by Product** | `SUM(revenue) GROUP BY product` | HUB already has this — just needs a widget on the per-product BI page |
| **Forecast Accuracy** | `1 − |predicted − actual| ÷ actual` | Requires HUB to store forecasts to compare against actuals |
| **Marketing-Sales Alignment** | multi-dimensional lead quality × attribution scoring | CRM lead scoring + marketing platform attribution |

**Integration approach:** likely a scheduled BullMQ job that pulls per-tenant
CRM data via each vendor's OAuth API into a new `crm_snapshots` table, with a
`CrmAdapter` interface parallel to the existing `StripeAdapter`.

### Support desk (ticket volume, resolution time)

Candidate systems: Zendesk, Intercom, HubSpot Service Hub, Freshdesk, Front.

| Metric | Formula | External data needed |
|---|---|---|
| **Support Ticket Volume** | `COUNT(tickets)` over a window | Ticket create events |
| **Tickets per Customer** | `tickets ÷ active_customers` | Above + Tier 1 active_customers |
| **Tickets per $1000 MRR** | `tickets ÷ (MRR / 100000)` | Above + Tier 1 MRR |
| **Average Resolution Time (ART)** | `SUM(resolution_seconds) ÷ COUNT(resolved)` | Ticket resolution events + timestamps |
| **First Response Time** | `SUM(first_response_seconds) ÷ COUNT(tickets)` | First-agent-reply timestamps |
| **CSAT / Customer Satisfaction** | `positive_ratings ÷ total_ratings × 100` | Post-ticket survey responses |

**Integration approach:** webhook receivers per support platform; per-tenant
config in `settings/notifications` extended with a new "Support integration"
section.

### Survey / NPS

Candidate systems: Delighted, Wootric, Ask Nicely, in-app survey via
LaunchKit primitive.

| Metric | Formula | External data needed |
|---|---|---|
| **NPS (Net Promoter Score)** | `(%promoters − %detractors)` where 9-10 = promoter, 0-6 = detractor | Survey responses per period |
| **NPS Response Rate** | `responses ÷ surveys_sent` | Survey delivery + response counts |

**Integration approach:** either a native LaunchKit-hosted survey primitive
(preferred — no vendor lock-in) or webhook receivers from 3rd-party survey
tools.

### Finance / accounting

Candidate systems: QuickBooks, Xero, Ramp, Mercury, Stripe (already integrated).

| Metric | Formula | External data needed |
|---|---|---|
| **Net Burn Rate** | `gross_burn − MRR` | Monthly spend from accounting ledger |
| **Runway (months)** | `cash_on_hand ÷ net_burn` | Cash balance from bank / accounting |
| **Gross Margin** | `(revenue − COGS) ÷ revenue` | COGS from accounting |

**Integration approach:** per-tenant OAuth adapter to accounting platform;
consumer of monthly close journal entries.

### Marketing platform (spend, attribution)

Candidate systems: Google Ads, Meta Ads, LinkedIn Ads, HubSpot Marketing,
GA4.

| Metric | Formula | External data needed |
|---|---|---|
| **Marketing Spend** | Direct field | Ad platform reporting API |
| **Cost per Lead** | `marketing_spend ÷ leads` | Above + CRM lead count |
| **Attributed MRR by Channel** | `SUM(MRR) GROUP BY first_touch_channel` | Attribution model + CRM channel-of-origin field |

**Integration approach:** batch pull via each platform's reporting API into a
new `marketing_snapshots` table.

---

## What HUB will NEVER measure

Some metrics belong outside a billing/licensing spine. Included here so we
don't accidentally scope creep them:

- **Employee productivity metrics** (calls per rep, emails sent, activity
  minutes) — belongs in a sales enablement / rep coaching tool, not HUB.
- **Product usage per session** at the event/click grain — belongs in a
  product analytics tool (Amplitude, Mixpanel, PostHog). HUB rolls up
  daily-window aggregates; nothing finer.
- **A/B experiment results** — belongs in an experimentation platform;
  HUB is the aggregation surface, not the assignment surface.

---

## Ordering suggestion (if we want to build the roadmap)

1. **Tier 2 — WAU/MAU + DAU:MAU stickiness ratio.** Highest ROI: unlocks
   engagement analytics without any new integration, just a new metric
   catalog entry + product-side push.
2. **Tier 2 — NRR + Quick Ratio.** Most demanded SaaS KPI on the list —
   needs one new event type per direction (expansion / upgrade / downgrade /
   churn) and derived tiles fall out.
3. **Tier 3 — CRM adapter for CAC / LTV:CAC.** First integration wave;
   pattern-establishing (adapter + snapshot table + widget) for later
   support/finance/marketing adapters to copy.
4. **Tier 3 — Support desk adapter.** Second integration wave; unlocks CSAT
   + ART + ticket volume.
5. **Tier 3 — Finance adapter.** Third integration wave; unlocks burn +
   runway + gross margin (which retros back into LTV:CAC accuracy).
