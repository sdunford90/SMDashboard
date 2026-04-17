# Southern Marinas Lead Response Dashboard

A Next.js 14 dashboard for tracking HubSpot CRM leads across all Southern Marinas properties. Shows lead metrics, action queues, speed-to-lead (business hours), conversion tracking, lead source breakdown, call analytics, property performance scorecard, and a word cloud from call notes. Password-protected.

## Architecture

- **Framework**: Next.js 14 (Pages Router)
- **Styling**: Tailwind CSS
- **Charts**: Recharts
- **Data source**: HubSpot CRM via `@hubspot/api-client`
- **Database**: Replit PostgreSQL (persistent cache, 8h TTL)
- **Auth**: Middleware session-cookie login (`DASHBOARD_PASSWORD`)

## Key Files

- `lib/leads.js` — Core data fetching, processing, caching, and classification logic
- `lib/hubspot.js` — HubSpot API client singleton
- `lib/db.js` — PostgreSQL connection + persistent cache helpers
- `middleware.js` — Session cookie auth protecting all routes except `/login`
- `instrumentation.js` — Warmup: pre-loads HubSpot data into cache on server start
- `pages/index.js` — Main dashboard UI (all tabs)
- `pages/api/leads.js` — Lead list + KPI metrics API
- `pages/api/action-queue.js` — Action queue tabs (missed calls, waiting, never responded)
- `pages/api/calls.js` — Call log + call notes word cloud data
- `pages/api/conversions.js` — Converted customers list + trends
- `pages/api/cache/clear.js` — Clears both in-memory and DB cache

## Dashboard Tabs

### Overview
- KPI cards: Total Leads, Response Rate, Avg Speed to Lead (biz hours), Conversion Rate
- Global date window: Last 7d (default) / 30d / 90d / All 2026
- Marina filter applies across all panels on this tab
- Action queue tabs: Missed Calls, Waiting on Reply, Never Responded, All Unresponded
  - 📋 green badge = form fill ≤7 days ago; blue = older form fill
- Lead Sources chart: By Property or By Source toggle (horizontal bar chart)
- Conversions panel: Total Converted, Avg Days to Convert, Fastest, trend chart, full table with Lead Source column (📞 Call / 📋 Web Form / Digital)

### All Leads
- Independent date filter (defaults to "Since Apr 1")
- Full sortable/filterable lead table

### Calls
- Call log with marina + period filter
- Calls by Property table with conversion rate
- Up to 60 call notes returned per marina

### Insights
- Property Job Score: single 0–100 badge per property blending response rate (35%), speed-to-lead median biz hours (30%), call coverage (25%), note coverage (10%). Click row to expand sub-signals. Conversion shown as separate Outcome column. <5 leads → "—". Sorted worst-first.
- Call Notes Word Cloud: top 80 words sized by frequency, stop words removed

## Contact Exclusions

- `hs_analytics_source NEQ "OFFLINE"` — removes IMPORT and Power Automate contacts (both share the OFFLINE source value)
- All data is from January 1, 2026 onward

## Lead Source Classification

`leadSource` (used in charts and conversions table):
- `CRM_UI` on either `hs_analytics_source` or `hs_analytics_source_data_1` → **Call** (phone/walk-in created in CRM)
- `recent_conversion_date` set → **Web Form** (any form fill, regardless of traffic source)
- Domain detected in `hs_analytics_source_data_1` → **Web Form**
- Else → **Digital**

`hsSource` (granular, used in By Source chart):
- CRM_UI → Call; form fill + paid search → Paid Search (Form); etc.
- Form fills always show as "Web Form"-variant labels regardless of traffic source

## Speed-to-Lead (Business Hours)

Calculated as 9am–5pm **7 days a week** in the marina's local timezone:

| Timezone | Properties |
|---|---|
| Central (CT) | Four Corners, Cedar Creek, Tims Ford, Grand Harbor, Millstone |
| Pacific (PT) | Hayden Lake, Elliott Bay |
| Eastern (ET) | All others |

`calcBusinessMinutes(startMs, endMs, tz)` in `lib/leads.js` handles DST-safe conversion via `Intl.DateTimeFormat`.

## Caching Strategy

Two-level cache:
1. **In-memory** (2h TTL) — fastest, resets on server restart
2. **PostgreSQL** (`hubspot_cache` table, 8h TTL) — persists across restarts

On startup `instrumentation.js` triggers a background warmup. Stale-while-revalidate pattern: API calls return cached data immediately while a background refresh runs. Request deduplication prevents multiple parallel HubSpot fetches.

## Environment Secrets Required

- `HUBSPOT_API_TOKEN` — HubSpot private app access token
- `DASHBOARD_PASSWORD` — Login password for the dashboard
- `HUBSPOT_PORTAL_ID` — HubSpot portal ID (for contact link generation)
- `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` — Replit PostgreSQL (auto-provisioned)

## Development

```bash
npm run dev   # starts on port 5000
npm run build
npm run start # production on port 5000
```
