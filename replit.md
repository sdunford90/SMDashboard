# Southern Marinas Lead Response Dashboard

A Next.js dashboard for tracking HubSpot leads, monitoring missed calls, response times, and action queues.

## Architecture

- **Framework**: Next.js 14 (Pages Router)
- **Styling**: Tailwind CSS
- **Charts**: Recharts
- **Data source**: HubSpot CRM via `@hubspot/api-client`
- **Database**: Replit PostgreSQL (persistent cache)

## Key Files

- `lib/leads.js` — Core data fetching & processing logic, in-memory + DB cache layer
- `lib/hubspot.js` — HubSpot API client singleton
- `lib/db.js` — PostgreSQL connection + persistent cache helpers
- `middleware.js` — Session cookie auth protecting all routes except `/login`
- `pages/api/` — API routes: leads, calls, speed-to-lead, action-queue, activity-feed
- `pages/api/cache/clear.js` — Clears both in-memory and DB cache

## Caching Strategy

Data from HubSpot is cached at two levels:

1. **In-memory** (5-minute TTL) — fastest, resets on server restart
2. **PostgreSQL** (`hubspot_cache` table, 5-minute TTL) — persists across restarts

On startup, if the in-memory cache is empty, the DB cache is checked first before making HubSpot API calls. This avoids cold-start latency after restarts.

Request deduplication is also in place — if multiple API routes call `getAllLeadsData()` simultaneously, only one HubSpot fetch runs; all callers share the same promise.

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
