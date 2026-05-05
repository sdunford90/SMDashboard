# Southern Marinas Lead Response Dashboard

A Next.js 14 dashboard for tracking HubSpot CRM leads across all Southern Marinas properties, displaying key metrics, action queues, and performance insights.

## Run & Operate

```bash
npm run dev   # Starts on port 5000
npm run build
npm run start # Production on port 5000
```

**Environment Variables:**
- `HUBSPOT_API_TOKEN`: HubSpot private app access token
- `DASHBOARD_PASSWORD`: Login password for the dashboard
- `HUBSPOT_PORTAL_ID`: HubSpot portal ID
- `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`: Replit PostgreSQL connection details

## Stack

- **Framework**: Next.js 14 (Pages Router)
- **Styling**: Tailwind CSS
- **Charts**: Recharts
- **Data Source**: HubSpot CRM (`@hubspot/api-client`)
- **Database**: Replit PostgreSQL (persistent cache)
- **Auth**: Middleware session-cookie login
- **Runtime**: Node.js (version implicit with Next.js 14)

## Where things live

- `lib/leads.js`: Core data fetching, processing, caching, and classification logic.
- `lib/hubspot.js`: HubSpot API client singleton.
- `lib/db.js`: PostgreSQL connection, cache helpers, and classifier decision store.
- `middleware.js`: Session cookie authentication.
- `instrumentation.js`: Startup tasks, crash handlers, heartbeat.
- `pages/index.js`: Main dashboard UI.
- `pages/api/*`: API routes for data endpoints.
- **DB Schema**: Defined implicitly by `lib/db.js` (tables: `leads`, `engagements`, `sync_state`, `classifier_decisions`).

## Architecture decisions

- **Data Refresh Strategy**: Employs incremental, full, and backfill refresh modes, with a bulk engagement watermark to optimize HubSpot API calls and ensure data consistency.
- **Multi-layered Caching**: Utilizes in-memory (2h TTL) and PostgreSQL (normalized tables for source-of-truth, JSON blob for legacy fallback) to balance speed and persistence.
- **Optimized HubSpot API Calls**: Uses batch API reads, parallel fetching of engagement types, and connection pooling to reduce API calls and improve performance.
- **Memory Management**: Implemented `MALLOC_ARENA_MAX=2`, V8 flags, idle-socket sweeps, and `global.gc()` calls to keep resident memory under control.
- **Sophisticated Lead Response Classification**: Defines "responded" based on meaningful engagements, lead source, and includes a 24-hour pre-anchor grace window for Web Form/Digital leads to account for pre-form interactions.

## Product

- **Lead Tracking**: Displays total leads, response rate, average speed to lead, and conversion rate.
- **Action Queues**: Categorizes leads into "Missed Calls," "Waiting on Reply," and "Never Responded."
- **Lead Source Analysis**: Visualizes lead sources by property or source type.
- **Call Analytics**: Provides call logs, calls by property, and a word cloud from call notes.
- **Property Performance Scorecard**: A 0-100 score blending response rate, speed-to-lead, call coverage, and note coverage for each property.
- **Conversion Tracking**: Lists converted customers, average days to convert, and conversion trends.
- **Authentication**: Password-protected dashboard access.

## User preferences

_Populate as you build_

## Gotchas

- **Speed-to-Lead Business Hours**: Calculated 9am–5pm, 7 days a week, in the marina's local timezone.
- **Spam Exclusion**: Spam contacts (`customer_type_2 = "Spam"`) are filtered out at multiple stages.
- **Data Age**: All data displayed is from January 1, 2026, onward.
- **Speed-to-Lead Average Eligibility**: Only "Web Form" or "Digital" leads that have responded with a measurable gap are included in average speed calculations.
- **DB Cache Reads**: Safeguarded with JS-side timeouts, client release on error, and in-flight deduplication to ensure dashboard renders even on failure.

## Pointers

- **Next.js Documentation**: [https://nextjs.org/docs](https://nextjs.org/docs)
- **Tailwind CSS Documentation**: [https://tailwindcss.com/docs](https://tailwindcss.com/docs)
- **Recharts Documentation**: [https://recharts.org/en-US/api](https://recharts.org/en-US/api)
- **HubSpot API Documentation**: [https://developers.hubspot.com/docs/api/overview](https://developers.hubspot.com/docs/api/overview)
- **PostgreSQL Documentation**: [https://www.postgresql.org/docs/](https://www.postgresql.org/docs/)