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
- `lib/db.js` — PostgreSQL connection + persistent cache helpers + classifier decision store
- `lib/ack-classifier.js` — Reply classifier; persists decisions to `classifier_decisions` so Insights stats survive restarts (90d retention, pruned every 6h)
- `middleware.js` — Session cookie auth protecting all routes except `/login`
- `instrumentation.js` — Startup: restores classifier metrics from DB, crash handlers, heartbeat logger (HubSpot warmup disabled)
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

- `customer_type_2 = "Spam"` — three-layer spam filtering: (1) Full refresh excludes spam at HubSpot API level. (2) Incremental refresh runs a spam sweep (`_sweepSpamFromDb`) that queries HubSpot for all spam contacts since cutoff and deletes any found in DB. (3) Batch processing detects spam in fetched contacts and deletes them. Spam contacts are removed from `leads` + `engagements` tables and filtered from in-memory cache.
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

## Data Storage & Caching

### Normalized DB Tables (source of truth)
- **`leads`** — one row per contact (`contact_id` PK, `data` JSONB with all derived fields, `updated_at`). Indexed on `(data->>'marina')`.
- **`engagements`** — one row per engagement-contact link (composite PK `(engagement_id, contact_id)`, `type`, `data` JSONB, `timestamp`). One HubSpot engagement can be associated with multiple contacts. Indexed on `contact_id` and `timestamp`.
- **`sync_state`** — tracks last successful refresh timestamp, contact/engagement counts. Includes `last_engagement_sync_at` (Task #25) — independent watermark for the engagement-modified search so contact-side and engagement-side refreshes can advance separately.

### Cache Layers
1. **In-memory** (2h TTL) — fastest, resets on server restart
2. **PostgreSQL normalized tables** — `getAllLeadsData()` reads from `leads` + `engagements` tables, applies `_applyRecompute`, and populates in-memory cache
3. **PostgreSQL JSON blob** (`hubspot_cache` table) — legacy fallback during transition, still written on refresh

### Refresh Modes
- **Incremental (default)**: `POST /api/refresh` — runs in two stages:
  1. **Bulk engagement watermark** (Task #25) — searches `emails`, `calls`, `notes`, `meetings` directly with `hs_lastmodifieddate >= last_engagement_sync_at` and uses v4 batch associations to map each engagement to its contacts. This is a small constant number of API calls regardless of how many contacts changed. Catches engagements whose contact-association lands AFTER the parent contact's `lastmodifieddate` updates (the failure mode the per-cycle recheck used to mop up).
  2. **Modified contacts** — `lastmodifieddate GTE` filter fetches contacts modified since last sync. For contacts already in the DB, the per-contact engagement walk is **skipped** (the bulk watermark above already populated them); only brand-new contacts get the full 4-list walk. Engagement IDs already in DB are skipped on the brand-new path too.
  After both stages, JSONB engagement arrays are patched on contacts whose engagements changed via the bulk watermark but whose contact record itself was not in the modified-contacts set.
- **Full**: `POST /api/refresh?force=true` — clears sync_state and re-fetches all contacts and engagements. Used for first run or recovery.
- **Backfill recheck**: `POST /api/refresh?backfill=true` — runs `_recheckUnrespondedEngagements` with no time bound and a high cap (5000) to mop up everything that drifted into the responded=false / 0-engagements state. Used after upstream HubSpot association issues are resolved.

### Engagement Recheck (`_recheckUnrespondedEngagements`)
Demoted to a periodic safety net as of Task #25 — runs once every 5 incremental refresh cycles, scoped to leads created in the last 7 days, with a per-call cap of 100 rows. The bulk engagement watermark above now covers the common case of HubSpot association propagation delays. Writes use a per-contact DB transaction (engagements table + leads JSONB updated atomically). After updates, patched leads are applied to the in-memory cache with `recomputeSpeedToLead` so the dashboard reflects changes immediately without waiting for a full cache rebuild.

### Per-Lead Manual Recheck
- `POST /api/lead-recheck/[id]` — re-fetches one contact's engagements directly from HubSpot, persists them, patches the JSONB engagements field, and refreshes the in-memory cache.
- Surfaced in the UI as a "↻ Recheck" button on every row of the **Never Responded** and **All Unresponded** action-queue tabs.

### Drift Metric
- `GET /api/cache-status` exposes `drift.unrespondedEmptyLast7d` — count of leads created in the last 7 days that are still `responded=false` with empty engagements. A non-zero count signals a regression in the sync pipeline.

### HubSpot API Optimization
- Engagement fetching uses `batchApi.read()` (up to 100 objects per call) instead of individual `getById()` calls, reducing thousands of API calls to dozens.
- Association IDs for all 4 engagement types (emails, calls, notes, meetings) are fetched in parallel per contact.
- **Connection pooling**: `lib/hubspot.js` monkey-patches `node-fetch` in `require.cache` before loading `@hubspot/api-client`, injecting a shared `https.Agent` (`keepAlive:true, maxSockets:6`) into every fetch call. Also sets `https.globalAgent` and passes `httpAgent` to the SDK constructor. This prevents the SDK's internal codegen layer from creating a new TLS connection per API call (was causing ~4.5GB RSS from socket buffers; now ~830MB during refresh).
- **Memory management**: bodyPreview trimmed to 200 chars. Batch-level memory logging every 5 batches.
- **Production start**: `node --expose-gc --max-old-space-size=1024` to cap V8 heap.

### Newsletter Form Fill Filter
- `isNewsletterFormName(/^events & news -/i)` strips newsletter signups from form-fill signals in both `processContact` (HubSpot fetch path) and `_stripNewsletterFromCachedLead` (`_applyRecompute` cache path).

### Crash Handlers & Monitoring
- `instrumentation.js`: `uncaughtException` and `unhandledRejection` handlers log to console before exit. 10-minute heartbeat logger reports PID, uptime, RSS, heap.
- `/api/health` — zero-dependency diagnostic endpoint (whitelisted in middleware, no auth required). Reports uptime, RSS, heap, PID.

Refresh is batched (BATCH_SIZE=100, ENGAGEMENT_CONCURRENCY=2, PROCESS_CONCURRENCY=4) to keep memory bounded on the 0.5 vCPU / 2 GB production VM. Per-batch progress is logged. Request deduplication via `_inFlightFetch` prevents multiple parallel HubSpot fetches.

DB cache reads carry safeguards: (1) a 25s JS-side timeout, (2) `client.release(err)` on timeout so a half-broken client is destroyed instead of poisoning the pool, (3) per-key in-flight dedup so a single dashboard page-load (5+ parallel API calls) only triggers one SELECT. When the read genuinely fails the caller falls through to an empty `{leads:[], byMarina:{}}` so the dashboard renders instead of spinning forever.

## Response Classification

A lead is "responded" when a meaningful engagement (`isMeaningfulResponse` in `lib/leads.js`) is found in its engagement timeline:
- Any logged MEETING
- Outbound non-automated EMAIL
- Logged CALL, outbound CALL with Connected/Voicemail disposition, or inbound Connected CALL
- Walk-in leads only: a NOTE with non-empty body

Whether a lead counts as responded depends on the lead source:

- **Call / Walk-in / Referral** — always responded. The contact only exists in HubSpot because a rep already had an inbound interaction (took a phone call, spoke to a walk-in, or received a referral handoff). The interaction itself IS the response, even if the rep logs the engagement before creating the contact record. The unresponded queues only ever contain Web Form / Digital leads.
- **Web Form / Digital** — responded only when there's a real outbound rep touch (logged call, outbound email, meeting, or walk-in note) timestamped at or after the **STL anchor**, with a **24-hour pre-anchor grace window** to absorb the common workflow where a rep proactively calls or emails a known prospect and the prospect then fills out a web form a few hours later (without this grace window the lead would show "Never Responded" despite a real outbound rep touch right before the form fill). Touches inside the grace window are clamped to the anchor for STL math, so STL is reported as 0 (responded at or before lead-in) rather than negative. The STL anchor is `MAX(createDate, recentFormDate)`, so when a returning customer fills out a form months or years after their original `createDate`, speed-to-lead is measured from that fresh form fill — not from the ancient original create date. Pre-anchor legacy engagements outside the 24-hour window are excluded so old emails don't misclassify a new re-engagement as already responded.

For Call / Walk-in / Referral leads the speed-to-lead value is clamped at 0 (response time can never be negative — the rep can't respond before the lead exists in the system).

`getAllLeadsData()` in `lib/leads.js` runs `recomputeSpeedToLead(lead)` over every cached lead once per cache load (DB → in-memory) and rebuilds `byMarina` from the patched leads. The same recompute also runs at the end of `_fetchFromHubSpot()` so the refresh-write path and the DB-load path produce byte-identical caches. This means every consumer endpoint — `/api/leads`, `/api/action-queue`, `/api/conversions`, `/api/presentation`, `/api/activity-feed`, `/api/speed-to-lead`, `/api/trends` — sees the same `responded` / `firstResponseTime` / `speedToLead*` / `firstResponse` values without each having to re-derive them. When STL rules change (e.g. grace window, response predicate), the fix shows immediately on already-cached leads without waiting for a full ~6-minute HubSpot refresh.

### Speed-to-Lead Average Eligibility

Marina / property / monthly speed-to-lead averages (`/api/speed-to-lead`, `/api/trends`, `/api/presentation`, and the in-page Property scorecard) only count leads that have actually responded with a measurable response gap. The shared helper `isSpeedToLeadEligible(lead)` exported from `lib/leads.js` requires:

- `leadSource === "Web Form"` or `"Digital"` — rep-initiated sources (Call / Walk-in / Referral) are excluded because their STL is trivially 0 (the rep already had the inbound interaction before the contact existed) and would pollute the average toward 0.
- `responded === true` and `speedIsPending === false` — pending unresponded leads have an elapsed-clock placeholder used by the action queue / pending display, but they haven't actually responded yet, so they're excluded from the answered-speed metric.
- `speedToLeadBizMinutes` is non-null.

The dashboard's "Responded" / total counts still include every lead so response-rate denominators are accurate; only the speed average is restricted.

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
