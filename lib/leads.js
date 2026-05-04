const { getHubSpotClient } = require("./hubspot");
const {
  getDbCache, getDbCacheWithStale, setDbCache, clearDbCache, getDbCacheMeta,
  upsertLeadRows, upsertEngagementRows, getEngagementsForContact: getDbEngagementsForContact,
  getDbLeadAndEngagementCounts, getExistingEngagementIds,
  getAllLeadsFromDb, getSyncState, setSyncState, clearLeadsTables,
  deleteLeadAndEngagements,
} = require("./db");

// --- Disposition GUID to Label mapping ---
// Includes both generic HubSpot defaults and this portal's actual GUIDs
const DISPOSITION_MAP = {
  // Generic defaults
  "73a0d17f-1163-4015-bdd5-ec2c5a5d5291": "Connected",
  "17b3e3e6-df6c-4b33-a8a1-6e566efca55f": "Left Voicemail",
  "f240bbac-87c4-4d47-a50b-a6e4f95d1cc8": "No Answer",
  "a4c4c7d3-5a19-4571-9879-2f0e6c989fc5": "Busy",
  "45d5d02e-3a26-445a-b8cb-b4614c2d8193": "Wrong Number",
  // This portal's actual GUIDs (verified against live call notes)
  "73a0d17f-1163-4015-bdd5-ec830791da20": "No Answer",
  "f240bbac-87c9-4f6e-bf70-924b57d47db7": "Connected",
  "a4c4c377-d246-4b32-a13b-75a56a4cd0ff": "Busy",
  "b2cf5968-551e-4856-9783-52b3da59a7d0": "Left Voicemail",
  "17b47fee-58de-441e-a44c-c6300d46f273": "Wrong Number",
  "9d9162e7-6cf3-4944-bf63-4dff82258764": "No Answer",
};

// --- Newsletter form fill detection ---
// HubSpot's `recent_conversion_event_name` aggregates ALL form submissions,
// including the generic Elementor newsletter widget that lives on every
// "Events & News" page. Those are mailing-list subscriptions, not sales
// inquiries — they shouldn't anchor speed-to-lead, count as a form fill,
// or surface a contact in the action queue. Every newsletter fill in the
// data starts with "events & news -" (the page slug). No real lead form
// uses that prefix.
const NEWSLETTER_FORM_RE = /^\s*events\s*&\s*news\s*-/i;
function isNewsletterFormName(name) {
  return typeof name === "string" && NEWSLETTER_FORM_RE.test(name);
}

// --- In-memory cache with 5-minute TTL ---
const cache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data;
  }
  cache.delete(key);
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

function clearCache() {
  cache.clear();
  clearDbCache().catch(() => {});
}

async function getCacheStatus() {
  const entry = cache.get("allLeads");
  if (entry) {
    return {
      cachedAt: new Date(entry.timestamp).toISOString(),
      expiresAt: new Date(entry.timestamp + CACHE_TTL).toISOString(),
      isRefreshing: _inFlightFetch !== null,
    };
  }
  const dbMeta = await getDbCacheMeta("allLeads");
  if (dbMeta) {
    return {
      cachedAt: dbMeta.cachedAt,
      expiresAt: dbMeta.expiresAt,
      isRefreshing: _inFlightFetch !== null,
    };
  }
  return {
    cachedAt: null,
    expiresAt: null,
    isRefreshing: _inFlightFetch !== null,
  };
}

function forceRefresh({ force = false } = {}) {
  cache.delete("allLeads");
  if (_inFlightFetch) return _inFlightFetch;
  const mode = force ? "full" : "incremental";
  console.log(`[cache] ${mode} refresh triggered.`);
  const doRefresh = async () => {
    if (force) {
      await clearLeadsTables();
    }
    return _fetchFromHubSpot({ forceFullRefresh: force });
  };
  _inFlightFetch = doRefresh().finally(() => { _inFlightFetch = null; });
  return _inFlightFetch;
}

// --- Strip HTML tags and decode common entities ---
function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Retry wrapper for HubSpot 429 rate limit errors ---
async function withRetry(fn, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 =
        err.code === 429 ||
        err?.response?.status === 429 ||
        (typeof err.message === "string" && err.message.includes("429"));
      if (is429 && attempt < retries) {
        const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// --- Concurrency limiter ---
async function withConcurrency(tasks, limit) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = task().then(
      (val) => ({ status: "fulfilled", value: val }),
      (err) => ({ status: "rejected", reason: err })
    );
    results.push(p);
    executing.add(p);
    p.then(() => executing.delete(p));
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

// --- Owner name cache ---
const ownerCache = new Map();

async function getOwnerName(ownerId) {
  if (!ownerId) return "Unassigned";
  if (ownerCache.has(ownerId)) return ownerCache.get(ownerId);
  try {
    const client = getHubSpotClient();
    const owner = await client.crm.owners.ownersApi.getById(ownerId);
    const name = `${owner.firstName || ""} ${owner.lastName || ""}`.trim() || "Unknown";
    ownerCache.set(ownerId, name);
    return name;
  } catch {
    ownerCache.set(ownerId, "Unknown");
    return "Unknown";
  }
}

// --- Business hours speed to lead (9am-5pm, 7 days/week, per-marina timezone) ---

// CT = America/Chicago, PT = America/Los_Angeles, default = America/New_York (ET)
const MARINA_TIMEZONE = {
  "Four Corners":  "America/Chicago",
  "Cedar Creek":   "America/Chicago",
  "Tims Ford":     "America/Chicago",
  "Grand Harbor":  "America/Chicago",
  "Millstone":     "America/Chicago",
  "Hayden Lake":   "America/Los_Angeles",
  "Elliott Bay":   "America/Los_Angeles",
};
const DEFAULT_TZ = "America/New_York";

function getMarinaTimezone(marina) {
  return MARINA_TIMEZONE[marina] || DEFAULT_TZ;
}

function tzDateStr(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms));
}

function nextDateStr(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

function tzHourToUTC(dateStr, hour, tz) {
  const approx = new Date(`${dateStr}T${String(hour).padStart(2, "0")}:00:00Z`);
  const tzHourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  }).format(approx);
  const tzHour = parseInt(tzHourStr.replace(/^24/, "0"));
  return approx.getTime() + (hour - tzHour) * 3600000;
}

// Cap on the elapsed-business-minutes "pending" clock for non-responded leads.
// 7 business days × 8 hours × 60 minutes = 3,360 minutes. Once a lead crosses
// this threshold its speed-to-lead is locked at the cap ("this lead is dead").
const MAX_PENDING_BIZ_MINUTES = 7 * 8 * 60;

// 9am–5pm in the marina's local timezone, 7 days a week.
//
// `capMinutes` lets callers short-circuit the day-by-day loop once the
// running total reaches a known cap. This is critical for very old
// unresponded leads, where the raw loop would iterate thousands of
// calendar days (one per year of age × 365) only to have the result
// clamped to MAX_PENDING_BIZ_MINUTES afterwards. Without the cap,
// running this over the ~700+ unresponded leads in the cache pinned
// the 0.5 vCPU production VM for minutes of synchronous work on every
// cold cache load, blocking the event loop and freezing the whole app.
function calcBusinessMinutes(startMs, endMs, tz = DEFAULT_TZ, capMinutes = Infinity) {
  if (!startMs || !endMs || endMs <= startMs) return 0;
  const BIZ_START_H = 9;
  const BIZ_END_H = 17;
  let total = 0;
  let dayStr = tzDateStr(startMs, tz);
  const lastDayStr = tzDateStr(endMs, tz);
  while (dayStr <= lastDayStr) {
    const bizStart = tzHourToUTC(dayStr, BIZ_START_H, tz);
    const bizEnd   = tzHourToUTC(dayStr, BIZ_END_H,   tz);
    const overlapStart = Math.max(startMs, bizStart);
    const overlapEnd   = Math.min(endMs,   bizEnd);
    if (overlapEnd > overlapStart) {
      total += (overlapEnd - overlapStart) / 60000;
      if (total >= capMinutes) return Math.round(capMinutes);
    }
    dayStr = nextDateStr(dayStr);
  }
  return Math.round(total);
}

// --- Fetch conversion date from property change history ---
async function fetchConversionDate(contactId) {
  const client = getHubSpotClient();
  try {
    const contact = await withRetry(() =>
      client.crm.contacts.basicApi.getById(contactId, [], ["customer_type_2"])
    );
    const history = contact.propertiesWithHistory?.customer_type_2 || [];
    const customerEntries = history.filter((h) => h.value === "Customer");
    if (customerEntries.length === 0) return null;
    customerEntries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return customerEntries[0].timestamp;
  } catch {
    return null;
  }
}

// --- Fetch contacts created on or after January 1, 2026 ---
async function fetchAllContacts() {
  const client = getHubSpotClient();
  const properties = [
    "firstname",
    "lastname",
    "email",
    "hs_lead_status",
    "createdate",
    "marina_location_2",
    "hubspot_owner_id",
    "phone",
    "customer_type_2",
    "customer_type",
    "hs_analytics_source_data_1",
    "hs_analytics_source",
    "lead_source",
    "recent_conversion_date",
    "recent_conversion_event_name",
    "first_conversion_date",
    "num_unique_conversion_events",
    "additional_comments",
    "customer_comments",
    "message",
    "inquiry_type",
    "type_of_inquiry",
    "storage_type",
    "boat_type",
    "boat_1_type",
    "boat_1_model",
    "boat_make_1",
    "boat_1_loa__in_feet_",
  ];

  const cutoffDate = new Date("2026-01-01T00:00:00.000Z");

  let allContacts = [];
  let after = undefined;

  do {
    const response = await withRetry(() =>
      client.crm.contacts.searchApi.doSearch({
        filterGroups: [
          {
            // Non-OFFLINE contacts (web forms, paid search, etc.)
            filters: [
              {
                propertyName: "createdate",
                operator: "GTE",
                value: cutoffDate.getTime().toString(),
              },
              {
                propertyName: "hs_analytics_source",
                operator: "NEQ",
                value: "OFFLINE",
              },
              {
                propertyName: "customer_type_2",
                operator: "NEQ",
                value: "Spam",
              },
            ],
          },
          {
            // OFFLINE contacts created manually via CRM UI (phone calls, walk-ins)
            // Excludes Power Automate (INTEGRATION) and bulk imports (IMPORT)
            filters: [
              {
                propertyName: "createdate",
                operator: "GTE",
                value: cutoffDate.getTime().toString(),
              },
              {
                propertyName: "hs_analytics_source",
                operator: "EQ",
                value: "OFFLINE",
              },
              {
                propertyName: "hs_analytics_source_data_1",
                operator: "EQ",
                value: "CRM_UI",
              },
              {
                propertyName: "customer_type_2",
                operator: "NEQ",
                value: "Spam",
              },
            ],
          },
          {
            // Re-engaged contacts: original record predates the 2026 cutoff
            // but the lead filled out a form in 2026, so they're an active
            // lead today. Include regardless of original source.
            filters: [
              {
                propertyName: "recent_conversion_date",
                operator: "GTE",
                value: cutoffDate.getTime().toString(),
              },
              {
                propertyName: "customer_type_2",
                operator: "NEQ",
                value: "Spam",
              },
            ],
          },
        ],
        properties,
        limit: 100,
        after: after || 0,
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      })
    );
    allContacts = allContacts.concat(response.results || []);
    after = response.paging?.next?.after;
    if (after) await new Promise((r) => setTimeout(r, 300));
  } while (after);

  return allContacts;
}

async function fetchModifiedContacts(sinceDate) {
  const client = getHubSpotClient();
  const properties = [
    "firstname", "lastname", "email", "hs_lead_status", "createdate",
    "marina_location_2", "hubspot_owner_id", "phone", "customer_type_2",
    "customer_type", "hs_analytics_source_data_1", "hs_analytics_source",
    "lead_source", "recent_conversion_date", "recent_conversion_event_name",
    "first_conversion_date", "num_unique_conversion_events",
    "additional_comments", "customer_comments", "message", "inquiry_type",
    "type_of_inquiry", "storage_type", "boat_type", "boat_1_type",
    "boat_1_model", "boat_make_1", "boat_1_loa__in_feet_",
  ];

  const cutoffDate = new Date("2026-01-01T00:00:00.000Z");
  const sinceMs = new Date(sinceDate).getTime().toString();

  let allContacts = [];
  let after = undefined;

  do {
    const response = await withRetry(() =>
      client.crm.contacts.searchApi.doSearch({
        filterGroups: [
          {
            filters: [
              { propertyName: "createdate", operator: "GTE", value: cutoffDate.getTime().toString() },
              { propertyName: "hs_analytics_source", operator: "NEQ", value: "OFFLINE" },
              { propertyName: "lastmodifieddate", operator: "GTE", value: sinceMs },
            ],
          },
          {
            filters: [
              { propertyName: "createdate", operator: "GTE", value: cutoffDate.getTime().toString() },
              { propertyName: "hs_analytics_source", operator: "EQ", value: "OFFLINE" },
              { propertyName: "hs_analytics_source_data_1", operator: "EQ", value: "CRM_UI" },
              { propertyName: "lastmodifieddate", operator: "GTE", value: sinceMs },
            ],
          },
          {
            filters: [
              { propertyName: "recent_conversion_date", operator: "GTE", value: cutoffDate.getTime().toString() },
              { propertyName: "lastmodifieddate", operator: "GTE", value: sinceMs },
            ],
          },
        ],
        properties,
        limit: 100,
        after: after || 0,
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      })
    );
    allContacts = allContacts.concat(response.results || []);
    after = response.paging?.next?.after;
    if (after) await new Promise((r) => setTimeout(r, 300));
  } while (after);

  return allContacts;
}

// --- Fetch engagements for a single contact ---
async function fetchAssociationIds(contactId, objectType) {
  const client = getHubSpotClient();
  const ids = [];
  try {
    let after = undefined;
    do {
      const resp = await withRetry(() =>
        client.crm.associations.v4.basicApi.getPage(
          "contacts",
          contactId,
          objectType,
          after,
          100
        )
      );
      if (resp.results) {
        for (const assoc of resp.results) {
          ids.push(String(assoc.toObjectId));
        }
      }
      after = resp.paging?.next?.after;
    } while (after);
  } catch {
    // No associations for this type
  }
  return ids;
}

async function batchReadObjects(objectApi, ids, properties) {
  if (ids.length === 0) return [];
  const results = [];
  const BATCH_SIZE = 100;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    try {
      const resp = await withRetry(() =>
        objectApi.batchApi.read({
          inputs: batch.map((id) => ({ id })),
          properties,
        })
      );
      if (resp.results) results.push(...resp.results);
    } catch (err) {
      console.warn(`[batch-read] batch error for ${batch.length} objects:`, err.message);
    }
  }
  return results;
}

function mapEmailResult(email) {
  const props = email.properties;
  return {
    type: "EMAIL",
    direction: props.hs_email_direction || "UNKNOWN",
    emailType: props.hs_email_type || null,
    sentBy: props.hs_email_sender_email || null,
    subject: props.hs_email_subject || "",
    timestamp: props.hs_timestamp || email.createdAt,
    loggedFrom: props.hs_email_logged_from || null,
    bodyPreview: (props.hs_email_text || "").slice(0, 200),
    engagementId: email.id,
    ownerId: props.hubspot_owner_id || null,
  };
}

function mapCallResult(call) {
  const props = call.properties;
  const dispositionGuid = props.hs_call_disposition || "";
  const callSource = (props.hs_call_source || "").toUpperCase();
  const hsIsLogged = props.hs_call_is_logged === "true";
  const isLogged =
    hsIsLogged ||
    callSource === "CRM_UI" ||
    callSource === "MANUAL_ENTRY" ||
    callSource === "INTEGRATIONS" ||
    (!callSource && !props.hs_call_recording_url);
  return {
    type: "CALL",
    direction: (props.hs_call_direction || "").toUpperCase() || "UNKNOWN",
    disposition: DISPOSITION_MAP[dispositionGuid] || dispositionGuid || "Unknown",
    dispositionRaw: dispositionGuid,
    durationMilliseconds: parseInt(props.hs_call_duration || "0", 10),
    body: stripHtml(props.hs_call_body || ""),
    recordingUrl: props.hs_call_recording_url || null,
    timestamp: props.hs_timestamp || call.createdAt,
    ownerId: props.hubspot_owner_id || null,
    callSource: callSource,
    isLogged,
    engagementId: call.id,
  };
}

function mapNoteResult(note) {
  const props = note.properties;
  const body = stripHtml(props.hs_note_body || "").trim();
  if (!body) return null;
  return {
    type: "NOTE",
    timestamp: props.hs_timestamp || note.createdAt,
    body,
    ownerId: props.hubspot_owner_id || null,
    engagementId: note.id,
  };
}

function mapMeetingResult(meeting) {
  const props = meeting.properties;
  const ts =
    meeting.createdAt ||
    props.hs_timestamp ||
    props.hs_meeting_start_time;
  return {
    type: "MEETING",
    timestamp: ts,
    title: (props.hs_meeting_title || "").trim(),
    body: stripHtml(props.hs_meeting_body || "").trim(),
    startTime: props.hs_meeting_start_time || null,
    endTime: props.hs_meeting_end_time || null,
    outcome: props.hs_meeting_outcome || null,
    activityType: props.hs_activity_type || null,
    ownerId: props.hubspot_owner_id || null,
    engagementId: meeting.id,
  };
}

const EMAIL_PROPERTIES = [
  "hs_email_direction", "hs_email_status", "hs_email_subject",
  "hs_timestamp", "hs_email_sender_email", "hs_email_logged_from",
  "hs_email_type", "hs_email_text", "hubspot_owner_id",
];
const CALL_PROPERTIES = [
  "hs_call_direction", "hs_call_disposition", "hs_call_duration",
  "hs_call_body", "hs_call_recording_url", "hs_timestamp",
  "hubspot_owner_id", "hs_call_source", "hs_call_is_logged",
];
const NOTE_PROPERTIES = ["hs_note_body", "hs_timestamp", "hubspot_owner_id"];
const MEETING_PROPERTIES = [
  "hs_meeting_title", "hs_meeting_body", "hs_meeting_start_time",
  "hs_meeting_end_time", "hs_meeting_outcome", "hs_timestamp",
  "hubspot_owner_id", "hs_activity_type",
];

async function fetchEngagementsForContact(contactId, skipIds) {
  const client = getHubSpotClient();
  const engagements = [];

  const [emailIds, callIds, noteIds, meetingIds] = await Promise.all([
    fetchAssociationIds(contactId, "emails"),
    fetchAssociationIds(contactId, "calls"),
    fetchAssociationIds(contactId, "notes"),
    fetchAssociationIds(contactId, "meetings"),
  ]);

  const filterIds = (ids) =>
    skipIds ? ids.filter((id) => !skipIds.has(id)) : ids;

  const newEmailIds = filterIds(emailIds);
  const newCallIds = filterIds(callIds);
  const newNoteIds = filterIds(noteIds);
  const newMeetingIds = filterIds(meetingIds);

  const [emails, calls, notes, meetings] = await Promise.all([
    batchReadObjects(client.crm.objects.emails, newEmailIds, EMAIL_PROPERTIES),
    batchReadObjects(client.crm.objects.calls, newCallIds, CALL_PROPERTIES),
    batchReadObjects(client.crm.objects.notes, newNoteIds, NOTE_PROPERTIES),
    batchReadObjects(client.crm.objects.meetings, newMeetingIds, MEETING_PROPERTIES),
  ]);

  for (const e of emails) engagements.push(mapEmailResult(e));
  for (const c of calls) engagements.push(mapCallResult(c));
  for (const n of notes) {
    const mapped = mapNoteResult(n);
    if (mapped) engagements.push(mapped);
  }
  for (const m of meetings) engagements.push(mapMeetingResult(m));

  const uniqueOwnerIds = [...new Set(engagements.filter((e) => e.ownerId).map((e) => e.ownerId))];
  await Promise.all(uniqueOwnerIds.map((id) => getOwnerName(id)));
  for (const eng of engagements) {
    if (eng.ownerId) eng.ownerName = ownerCache.get(eng.ownerId) || null;
  }

  engagements.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return engagements;
}

// --- Determine email subtype ---
function getEmailSubtype(engagement) {
  const dir = engagement.direction;
  if (dir === "INCOMING" || dir === "INBOUND" || dir === "INCOMING_EMAIL") {
    return "EMAIL_INBOUND";
  }
  if (engagement.loggedFrom === "CRM") {
    return "EMAIL_LOGGED";
  }
  return "EMAIL_SENT";
}

// --- Lightweight meaningful-response predicate for the cache recompute ---
// Mirrors isMeaningfulResponse below but lives near the recompute helper so
// the cache-side fix doesn't depend on later definitions.
function _recomputeIsMeaningful(e) {
  if (!e) return false;
  if (e.type === "MEETING") return true;
  if (e.type === "EMAIL") {
    const dir = e.direction;
    if (dir !== "OUTGOING" && dir !== "OUTBOUND" && dir !== "FORWARDED_EMAIL" && dir !== "EMAIL") return false;
    return e.emailType !== "AUTOMATED";
  }
  if (e.type === "CALL") {
    if (e.isLogged) return true;
    if (e.direction === "OUTBOUND") return e.disposition === "Connected" || e.disposition === "Left Voicemail";
    if (e.direction === "INBOUND") return e.disposition === "Connected";
  }
  return false;
}

// --- Recompute responded / firstResponseTime / speedToLead* on a cached lead ---
// Applied centrally in getAllLeadsData() so every consumer (action queue,
// conversions, presentation, activity feed, etc.) sees consistent values
// without each endpoint having to redo the math. Returns a patched copy
// when the recompute changes anything; returns null to signal "use cache as-is".
//
// Why this exists at the cache-read layer (not just at refresh time):
// response-detection rules evolve faster than the ~6-minute HubSpot refresh,
// so we re-derive the few volatile fields on every read instead of forcing
// a full re-fetch when we tweak the rules.
function recomputeSpeedToLead(lead) {
  if (!lead) return null;
  const repInitiated =
    lead.leadSource === "Call" || lead.leadSource === "Walk-in" || lead.leadSource === "Referral";
  if (repInitiated) return null;
  if (!lead.createDate) return null;
  const created = new Date(lead.createDate);
  if (isNaN(created.getTime())) return null;
  const formRaw = lead.recentFormDate ? new Date(lead.recentFormDate) : null;
  const anchor =
    formRaw && !isNaN(formRaw.getTime()) && formRaw.getTime() > created.getTime()
      ? formRaw
      : created;
  const engs = lead.engagements || [];
  const GRACE_MS = 24 * 60 * 60 * 1000;
  const earliest = anchor.getTime() - GRACE_MS;
  const fr = engs.find((e) => {
    if (!e.timestamp) return false;
    if (new Date(e.timestamp).getTime() < earliest) return false;
    return _recomputeIsMeaningful(e);
  });
  const tz = getMarinaTimezone(lead.marina);

  if (!fr) {
    // Cap the day-by-day loop at MAX_PENDING_BIZ_MINUTES — the value
    // is clamped to the cap on the next line anyway, and old leads
    // can otherwise force thousands of needless iterations.
    const elapsedBiz = calcBusinessMinutes(
      anchor.getTime(),
      Date.now(),
      tz,
      MAX_PENDING_BIZ_MINUTES
    );
    return {
      ...lead,
      responded: false,
      firstResponseTime: null,
      speedToLeadMinutes: null,
      speedToLeadBizMinutes: Math.min(Math.max(elapsedBiz, 0), MAX_PENDING_BIZ_MINUTES),
      speedIsPending: true,
      firstResponse: null,
    };
  }

  const rawTs = new Date(fr.timestamp);
  const respTs = new Date(Math.max(rawTs.getTime(), anchor.getTime()));
  const stlMin = (respTs.getTime() - anchor.getTime()) / 60000;
  const stlBizMin = calcBusinessMinutes(anchor.getTime(), respTs.getTime(), tz);
  let subtype = null;
  if (fr.type === "EMAIL") {
    const dir = fr.direction;
    if (dir === "INCOMING" || dir === "INBOUND" || dir === "INCOMING_EMAIL") subtype = "EMAIL_INBOUND";
    else if (fr.loggedFrom === "CRM") subtype = "EMAIL_LOGGED";
    else subtype = "EMAIL_SENT";
  } else if (fr.type === "CALL") {
    subtype = fr.direction === "INBOUND" ? "INBOUND_CALL" : "OUTBOUND_CALL";
  } else {
    subtype = fr.type;
  }
  return {
    ...lead,
    responded: true,
    firstResponseTime: respTs.toISOString(),
    speedToLeadMinutes: stlMin,
    speedToLeadBizMinutes: stlBizMin,
    speedIsPending: false,
    firstResponse: {
      type: fr.type,
      subtype,
      timestamp: fr.timestamp,
      disposition: fr.disposition || null,
      synthetic: false,
    },
  };
}

// --- Whether a lead should be included in speed-to-lead averages ---
// We only count Web Form / Digital leads that have a real measurable
// response gap. Excluded:
//   - Rep-initiated sources (Call / Walk-in / Referral) — their
//     "response" IS the lead-in event, so STL is trivially 0 and
//     pollutes the average.
//   - Pending unresponded leads (speedIsPending) — they haven't actually
//     responded yet; the elapsed-clock placeholder is for the action
//     queue / pending display, not the answered-speed metric.
//   - Leads with no STL value at all.
function isSpeedToLeadEligible(lead) {
  if (!lead) return false;
  if (lead.leadSource !== "Web Form" && lead.leadSource !== "Digital") return false;
  if (!lead.responded) return false;
  if (lead.speedIsPending) return false;
  if (lead.speedToLeadBizMinutes === null || lead.speedToLeadBizMinutes === undefined) return false;
  return true;
}

// --- Check if engagement is a meaningful response ---
function isMeaningfulResponse(engagement) {
  // A logged meeting (whether already happened or scheduled in the future)
  // means a rep made real contact / committed time with this lead, so it
  // counts as a response.
  if (engagement.type === "MEETING") return true;
  if (engagement.type === "EMAIL") {
    // Must be outbound and not automated
    const dir = engagement.direction;
    if (dir !== "OUTGOING" && dir !== "OUTBOUND" && dir !== "FORWARDED_EMAIL" && dir !== "EMAIL") return false;
    if (engagement.emailType === "AUTOMATED") return false;
    return true;
  }
  if (engagement.type === "CALL") {
    // Logged calls (manually entered by rep) always count as a response
    if (engagement.isLogged) return true;
    // Outbound connected or left voicemail
    if (engagement.direction === "OUTBOUND") {
      return (
        engagement.disposition === "Connected" ||
        engagement.disposition === "Left Voicemail"
      );
    }
    // Inbound connected call counts
    if (engagement.direction === "INBOUND") {
      return engagement.disposition === "Connected";
    }
  }
  return false;
}

// --- Check if engagement is an outbound rep touch ---
function isRepTouch(engagement) {
  if (engagement.type === "EMAIL") {
    const dir = engagement.direction;
    return (dir === "OUTGOING" || dir === "OUTBOUND" || dir === "FORWARDED_EMAIL" || dir === "EMAIL") &&
      engagement.emailType !== "AUTOMATED";
  }
  if (engagement.type === "CALL") {
    if (engagement.direction === "OUTBOUND") return true;
    // Inbound connected call = rep participated
    if (engagement.direction === "INBOUND" && engagement.disposition === "Connected") return true;
  }
  return false;
}

// --- Check if engagement is inbound from lead ---
function isInboundFromLead(engagement) {
  if (engagement.type === "EMAIL") {
    const dir = engagement.direction;
    return dir === "INCOMING" || dir === "INBOUND" || dir === "INCOMING_EMAIL";
  }
  if (engagement.type === "CALL") {
    return engagement.direction === "INBOUND" && engagement.disposition === "Connected";
  }
  return false;
}

// --- Check if a call is a missed inbound ---
// Logged (manually entered) calls are excluded — the rep already knew about the call
// and documented it intentionally, so it is not an unattended missed call.
function isMissedInboundCall(engagement) {
  return (
    engagement.type === "CALL" &&
    !engagement.isLogged &&
    engagement.direction === "INBOUND" &&
    (engagement.disposition === "No Answer" ||
      engagement.disposition === "Busy" ||
      engagement.disposition === "Wrong Number")
  );
}

// --- Resolve lead source from contact properties (used early in processContact) ---
function resolveLeadSource(props) {
  const s1 = props.hs_analytics_source_data_1 || "";
  const src = props.hs_analytics_source || "";
  const crmLeadSrc = (props.lead_source || "").toLowerCase();
  if (s1 === "CRM_UI" || src === "CRM_UI") {
    if (crmLeadSrc.includes("walk")) return "Walk-in";
    if (crmLeadSrc.includes("phone") || crmLeadSrc.includes("call")) return "Call";
    if (crmLeadSrc.includes("referral")) return "Referral";
    if (crmLeadSrc.includes("web") || crmLeadSrc.includes("form") || crmLeadSrc.includes("online")) return "Web Form";
    return "Call";
  }
  if (props.recent_conversion_date) return "Web Form";
  if (s1.includes(".com") || s1.includes(".net") || s1.includes(".org") || s1.includes(".co")) return "Web Form";
  return "Digital";
}

const { classifyInbound } = require("./ack-classifier");

// --- Process a single contact with engagements ---
async function processContact(contact, engagements) {
  const props = contact.properties;
  const contactId = contact.id;
  const createDate = new Date(props.createdate);

  // Strip newsletter signup from the conversion props before any
  // downstream code reads them. Newsletters aren't sales leads — they
  // shouldn't anchor speed-to-lead, drive Web Form classification, or
  // count toward numFormFills. We only know about the MOST recent
  // conversion (HubSpot doesn't expose per-fill history), so:
  //   - if num_unique_conversion_events == 1, the newsletter is the
  //     only signal → null out everything.
  //   - if > 1, decrement the count and clear the "recent" fields, but
  //     keep first_conversion_date since at least one earlier real
  //     fill exists (we just can't recover its date).
  if (isNewsletterFormName(props.recent_conversion_event_name)) {
    const totalFills = parseInt(props.num_unique_conversion_events, 10) || 0;
    props.recent_conversion_date = null;
    props.recent_conversion_event_name = null;
    if (totalFills <= 1) {
      props.first_conversion_date = null;
      props.num_unique_conversion_events = "0";
    } else {
      props.num_unique_conversion_events = String(totalFills - 1);
    }
  }

  // Resolve marina + timezone early (needed for speed-to-lead calc)
  const marina = (props.marina_location_2 || "Unknown").split(";")[0].trim();
  const tz = getMarinaTimezone(marina);

  // Resolve lead source early — needed for Walk-in response logic below
  const leadSource = resolveLeadSource(props);
  const isWalkIn = leadSource === "Walk-in";

  // Find first meaningful response.
  // Behavior depends on lead source:
  //
  // - Call / Walk-in / Referral: the contact only exists in HubSpot because
  //   a rep already had an interaction with the prospect (inbound call,
  //   walk-in conversation, or referral handoff). The lead is responded by
  //   definition — no engagement search required. We still try to find the
  //   actual logged engagement so the firstResponseTime / lastTouch fields
  //   point at a real record; if none exists yet, we synthesize one anchored
  //   to createDate.
  //
  // - Web Form / Digital: the contact is created automatically the moment
  //   the prospect converts, so we require an actual outbound rep touch
  //   (call, email, meeting) at or after the lead-in event. A 30-minute
  //   grace window absorbs clock skew between HubSpot's form-submission
  //   timestamp and an immediate auto-logged response. Returning customers'
  //   legacy engagements (months/years before this re-engagement) are
  //   excluded.
  //
  // The "lead-in" anchor (stlAnchor) for speed-to-lead measurement is the
  // most recent of: contact createDate, most recent form conversion. This
  // matters for returning customers whose contact may be a year old but who
  // re-converted recently — without this anchor we'd measure response time
  // from the original ancient createDate and report multi-month lags for
  // leads that were actually responded to in minutes.
  const repInitiated = leadSource === "Call" || isWalkIn || leadSource === "Referral";
  const recentFormDateRaw = props.recent_conversion_date ? new Date(props.recent_conversion_date) : null;
  const stlAnchor =
    !repInitiated && recentFormDateRaw && !isNaN(recentFormDateRaw.getTime()) && recentFormDateRaw.getTime() > createDate.getTime()
      ? recentFormDateRaw
      : createDate;
  let firstResponse;
  if (repInitiated) {
    // Prefer the most recent meaningful engagement on or before createDate
    // (typically the inbound call the rep logged before creating the contact).
    // Fallback: any meaningful engagement at all. Final fallback: synthesize.
    const candidatesPre = engagements.filter((e) => {
      const ts = e.timestamp ? new Date(e.timestamp) : null;
      if (!ts || isNaN(ts.getTime()) || ts > createDate) return false;
      if (isMeaningfulResponse(e)) return true;
      if (isWalkIn && e.type === "NOTE" && (e.body || "").trim().length > 0) return true;
      return false;
    });
    if (candidatesPre.length > 0) {
      firstResponse = candidatesPre[candidatesPre.length - 1];
    } else {
      const post = engagements.find((e) => {
        if (isMeaningfulResponse(e)) return true;
        if (isWalkIn && e.type === "NOTE" && (e.body || "").trim().length > 0) return true;
        return false;
      });
      firstResponse = post || {
        type: "SYNTHETIC",
        timestamp: props.createdate,
        synthetic: true,
        leadSource,
      };
    }
  } else {
    // Web Form / Digital
    // Pre-anchor grace window: a meaningful rep touch (logged call,
    // outbound non-automated email, meeting, connected/voicemail outbound
    // call, connected inbound call) within this window BEFORE the form
    // fill counts as a response. This handles the common workflow where a
    // rep proactively calls / emails a known prospect and the prospect
    // then fills out a form a few hours later — without this, the lead
    // would show "Never Responded" even though the rep already engaged.
    // 24 hours is wide enough to catch same-business-day pre-form touches
    // while staying tight enough to exclude old marketing engagements
    // from a returning customer's prior lifecycle.
    const RESPONSE_GRACE_MS = 24 * 60 * 60 * 1000;
    const earliestAllowed = new Date(stlAnchor.getTime() - RESPONSE_GRACE_MS);
    firstResponse = engagements.find((e) => {
      const ts = e.timestamp ? new Date(e.timestamp) : null;
      if (!ts || isNaN(ts.getTime()) || ts < earliestAllowed) return false;
      return isMeaningfulResponse(e);
    });
  }
  // Anchor firstResponseTime at stlAnchor at the earliest — for repInitiated
  // leads the inbound interaction often predates createDate, but speed-to-lead
  // can never be negative (the rep can't respond before the lead exists).
  const rawResponseTime = firstResponse ? new Date(firstResponse.timestamp) : null;
  const firstResponseTime = rawResponseTime
    ? new Date(Math.max(rawResponseTime.getTime(), stlAnchor.getTime()))
    : null;
  let speedToLeadMinutes = firstResponseTime
    ? (firstResponseTime - stlAnchor) / (1000 * 60)
    : null;
  let speedToLeadBizMinutes = firstResponseTime
    ? calcBusinessMinutes(stlAnchor.getTime(), firstResponseTime.getTime(), tz)
    : null;

  // Pending elapsed-clock fallback for non-responded, non-walk-in leads.
  // Counts business minutes from the lead-in anchor (most recent of
  // createDate / recent form fill) to "now" (this cache snapshot), capped
  // at 7 business days. Locked to the real response time the moment a
  // firm response is logged. Walk-ins are excluded — their "response" is
  // a NOTE and reps are inconsistent about logging notes.
  let speedIsPending = false;
  if (!firstResponseTime && !isWalkIn && createDate) {
    // Even if elapsed business minutes is 0 (lead created off-hours and no
    // biz time has accrued yet), set the value to 0 so the lead is included
    // in the running average from the moment it's created.
    // Cap the day-by-day loop at MAX_PENDING_BIZ_MINUTES so very old
    // unresponded leads don't force thousands of pointless iterations.
    const elapsedBiz = calcBusinessMinutes(
      stlAnchor.getTime(),
      Date.now(),
      tz,
      MAX_PENDING_BIZ_MINUTES
    );
    speedToLeadBizMinutes = Math.min(Math.max(elapsedBiz, 0), MAX_PENDING_BIZ_MINUTES);
    speedIsPending = true;
  }

  // Waiting on reply: last engagement is inbound from lead with no rep touch after it.
  // We additionally classify that inbound message — if it's just an acknowledgment
  // ("thanks", "got it", etc.) we don't surface the lead in the action queue.
  let waitingOnReply = false;
  let waitingSince = null;
  let lastInboundIsAck = false;
  let lastInboundAckLabel = null;
  let lastInboundAckReason = null;
  let lastInboundEngagement = null;
  if (engagements.length > 0) {
    for (let i = engagements.length - 1; i >= 0; i--) {
      const e = engagements[i];
      if (isRepTouch(e)) break;
      if (isInboundFromLead(e)) {
        lastInboundEngagement = e;
        waitingOnReply = true;
        waitingSince = e.timestamp;
        break;
      }
    }
  }

  // If the last inbound is an email-style message (not a call), classify it.
  // Inbound calls always count as "needs follow-up" — only emails get filtered.
  // Set DISABLE_AI_CLASSIFIER=true to skip Anthropic calls entirely (e.g. when
  // hitting rate limits or to make refreshes faster). With it disabled, every
  // inbound email is treated as needing follow-up.
  if (
    lastInboundEngagement &&
    lastInboundEngagement.type === "EMAIL" &&
    process.env.DISABLE_AI_CLASSIFIER !== "true"
  ) {
    try {
      const verdict = await classifyInbound(lastInboundEngagement);
      lastInboundAckLabel = verdict.label || null;
      lastInboundAckReason = verdict.reason || null;
      if (verdict.needsResponse === false) {
        lastInboundIsAck = true;
        waitingOnReply = false;
        waitingSince = null;
      }
    } catch (err) {
      console.warn("[ack-classifier] processContact error:", err.message);
    }
  }

  // Missed inbound call with no follow-up
  let hasMissedInbound = false;
  let missedCallTime = null;
  let missedCallAttempts = 0;
  for (let i = engagements.length - 1; i >= 0; i--) {
    const e = engagements[i];
    if (isRepTouch(e)) break; // Rep touched after, not flagged
    if (isMissedInboundCall(e)) {
      hasMissedInbound = true;
      missedCallTime = missedCallTime || e.timestamp;
      missedCallAttempts++;
    }
  }

  // Count no-answer outbound attempts
  let noAnswerOutboundCount = engagements.filter(
    (e) =>
      e.type === "CALL" &&
      e.direction === "OUTBOUND" &&
      (e.disposition === "No Answer" || e.disposition === "Busy" || e.disposition === "Wrong Number")
  ).length;

  // Engagement counts
  const emailsSent = engagements.filter(
    (e) => e.type === "EMAIL" && (e.direction === "OUTGOING" || e.direction === "OUTBOUND") && e.loggedFrom !== "CRM"
  ).length;
  const emailsLogged = engagements.filter(
    (e) => e.type === "EMAIL" && e.loggedFrom === "CRM"
  ).length;
  const callsOutbound = engagements.filter(
    (e) => e.type === "CALL" && e.direction === "OUTBOUND"
  ).length;
  const callsInbound = engagements.filter(
    (e) => e.type === "CALL" && e.direction === "INBOUND"
  ).length;
  const callsConnected = engagements.filter(
    (e) => e.type === "CALL" && e.disposition === "Connected"
  ).length;
  const callsLogged = engagements.filter(
    (e) => e.type === "CALL" && e.isLogged
  ).length;
  const callsLoggedWithNotes = engagements.filter(
    (e) => e.type === "CALL" && e.isLogged && (e.body || "").trim().length > 0
  ).length;

  // Last touch
  const lastEngagement = engagements.length > 0 ? engagements[engagements.length - 1] : null;

  // Last lead-initiated activity timestamp: latest of create date, last form
  // submission, or most recent inbound call from the lead. Used to compute
  // wait time and to decide whether a lead falls inside a date window even
  // when the original contact record is old.
  let lastLeadActivityMs = createDate ? createDate.getTime() : 0;
  if (props.recent_conversion_date) {
    const t = new Date(props.recent_conversion_date).getTime();
    if (t > lastLeadActivityMs) lastLeadActivityMs = t;
  }
  for (const e of engagements) {
    if (e.type === "CALL" && e.direction === "INBOUND" && e.timestamp) {
      const t = new Date(e.timestamp).getTime();
      if (t > lastLeadActivityMs) lastLeadActivityMs = t;
    }
  }
  const lastLeadActivityAt = lastLeadActivityMs ? new Date(lastLeadActivityMs).toISOString() : null;

  return {
    contactId,
    firstName: props.firstname || "",
    lastName: props.lastname || "",
    name: `${props.firstname || ""} ${props.lastname || ""}`.trim() || "Unknown",
    email: props.email || "",
    phone: props.phone || "",
    leadStatus: props.hs_lead_status || "",
    createDate: props.createdate,
    marina,
    ownerId: props.hubspot_owner_id || null,
    ownerName: null, // filled in later
    responded: !!firstResponse,
    firstResponseTime: firstResponseTime ? firstResponseTime.toISOString() : null,
    speedToLeadMinutes,
    speedToLeadBizMinutes,
    speedIsPending,
    waitingOnReply,
    waitingSince,
    lastInboundIsAck,
    lastInboundAckLabel,
    lastInboundAckReason,
    lastInboundEngagementId: lastInboundEngagement ? (lastInboundEngagement.id || lastInboundEngagement.engagementId || null) : null,
    lastInboundTimestamp: lastInboundEngagement ? lastInboundEngagement.timestamp : null,
    hasMissedInbound,
    missedCallTime,
    missedCallAttempts,
    noAnswerOutboundCount,
    emailsSent,
    emailsLogged,
    callsOutbound,
    callsInbound,
    callsConnected,
    callsLogged,
    callsLoggedWithNotes,
    lastTouch: lastEngagement
      ? {
          type: lastEngagement.type,
          subtype:
            lastEngagement.type === "EMAIL"
              ? getEmailSubtype(lastEngagement)
              : lastEngagement.direction === "INBOUND"
              ? "INBOUND_CALL"
              : "OUTBOUND_CALL",
          timestamp: lastEngagement.timestamp,
          disposition: lastEngagement.disposition || null,
        }
      : null,
    firstResponse: firstResponse
      ? {
          type: firstResponse.type || null,
          subtype:
            firstResponse.type === "EMAIL"
              ? getEmailSubtype(firstResponse)
              : firstResponse.type === "CALL"
              ? (firstResponse.direction === "INBOUND" ? "INBOUND_CALL" : "OUTBOUND_CALL")
              : firstResponse.type === "MEETING"
              ? "MEETING"
              : firstResponse.type === "NOTE"
              ? "NOTE"
              : firstResponse.type === "SYNTHETIC"
              ? "SYNTHETIC"
              : null,
          timestamp: firstResponse.timestamp || null,
          disposition: firstResponse.disposition || null,
          synthetic: !!firstResponse.synthetic,
        }
      : null,
    leadSource,
    hsSource: (() => {
      const src = props.hs_analytics_source || "";
      const s1 = props.hs_analytics_source_data_1 || "";
      const crmLeadSrc = (props.lead_source || "").trim();
      if (s1 === "CRM_UI" || src === "CRM_UI") {
        // Use the HubSpot lead_source field for granular label
        if (crmLeadSrc) return crmLeadSrc; // e.g. "Phone Call", "Walk-In", "Referral"
        return "Call"; // fallback for manual entries with no lead_source
      }
      if (props.recent_conversion_date) {
        if (src === "PAID_SEARCH") return "Paid Search (Form)";
        if (src === "ORGANIC_SEARCH") return "Organic Search (Form)";
        if (src === "SOCIAL_MEDIA") return "Social (Form)";
        if (src === "DIRECT_TRAFFIC") return "Direct (Form)";
        if (src === "REFERRALS") return "Referral (Form)";
        return "Web Form";
      }
      if (src === "PAID_SEARCH") return "Paid Search";
      if (src === "ORGANIC_SEARCH") return "Organic Search";
      if (src === "SOCIAL_MEDIA") return "Social Media";
      if (src === "DIRECT_TRAFFIC") return "Direct Traffic";
      if (src === "REFERRALS") return "Referral";
      if (src === "EMAIL_MARKETING") return "Email";
      return src || "Unknown";
    })(),
    lastLeadActivityAt,
    recentFormDate: props.recent_conversion_date || null,
    recentFormName: props.recent_conversion_event_name || null,
    firstFormDate: props.first_conversion_date || null,
    numFormFills: props.num_unique_conversion_events ? parseInt(props.num_unique_conversion_events, 10) : 0,
    formAsk: buildFormAsk(props),
    isSpam: props.customer_type_2 === "Spam",
    isCustomer: props.customer_type_2 === "Customer",
    isBoatClub: (props.customer_type || "").toLowerCase().includes("boat club"),
    customerType: props.customer_type || null,
    convertedAt: null,    // filled in later for customers
    daysToConvert: null,  // filled in later for customers
    engagements,
    hubspotUrl: `https://app.hubspot.com/contacts/${process.env.HUBSPOT_PORTAL_ID || "PORTAL_ID"}/contact/${contactId}`,
  };
}

// --- In-flight deduplication: all concurrent callers share one fetch ---
let _inFlightFetch = null;

// --- Main data fetcher ---
// The dashboard reads exclusively from the in-memory + DB cache. HubSpot
// is only contacted when the user explicitly clicks the refresh button
// (which calls forceRefresh() via /api/refresh). If the DB cache is empty,
// we return an empty dataset so the UI loads instantly instead of hanging
// on a multi-minute HubSpot fetch.
// Apply recomputeSpeedToLead to every lead and rebuild byMarina from the
// patched leads so consumer endpoints (action queue, conversions,
// presentation, activity feed, etc.) all see the same responded /
// firstResponseTime / speed values without each having to redo the math.
// Mirror of the newsletter-strip done in processContact, but applied
// against an already-processed cached lead. Lets the filter take effect
// immediately on the next request without needing a fresh HubSpot pull.
//
// `leadSource` and `hsSource` are intentionally left untouched here —
// resolveLeadSource needs the raw HubSpot props (hs_analytics_source*,
// lead_source, recent_conversion_date), which aren't preserved on
// cached leads. A small number of newsletter-only contacts may
// therefore stay classified as "Web Form" or "X (Form)" on cached
// reads until the next HubSpot refresh re-runs processContact end to
// end. This is purely cosmetic: isSpeedToLeadEligible accepts both
// "Web Form" and "Digital", so the eligibility outcome is identical
// either way; the only visible effect is a small inflation in the
// dashboard's "By Source" breakdown for ≤15 contacts.
function _stripNewsletterFromCachedLead(lead) {
  if (!lead || !isNewsletterFormName(lead.recentFormName)) return lead;
  const total = lead.numFormFills || 0;
  const next = { ...lead, recentFormDate: null, recentFormName: null };
  if (total <= 1) {
    next.firstFormDate = null;
    next.numFormFills = 0;
  } else {
    next.numFormFills = total - 1;
  }
  return next;
}

function _applyRecompute(data) {
  if (!data || !Array.isArray(data.leads)) return data;
  const patchedLeads = data.leads
    .map(_stripNewsletterFromCachedLead)
    .map((l) => recomputeSpeedToLead(l) || l);
  const byMarina = {};
  for (const l of patchedLeads) {
    const m = l.marina || "Unknown";
    if (!byMarina[m]) byMarina[m] = [];
    byMarina[m].push(l);
  }
  return { ...data, leads: patchedLeads, byMarina };
}

async function getAllLeadsData() {
  const cached = getCached("allLeads");
  if (cached) return cached;

  const dbData = await getAllLeadsFromDb();
  if (dbData && dbData.leads.length > 0) {
    const recomputed = _applyRecompute(dbData);
    setCache("allLeads", recomputed);
    return recomputed;
  }

  const dbEntry = await getDbCacheWithStale("allLeads");
  if (dbEntry) {
    const recomputed = _applyRecompute(dbEntry.data);
    setCache("allLeads", recomputed);
    return recomputed;
  }

  return { leads: [], byMarina: {} };
}

async function _processContactBatch(contacts, { incremental = false } = {}) {
  const BATCH_SIZE = 100;
  const ENGAGEMENT_CONCURRENCY = 2;
  const PROCESS_CONCURRENCY = 4;
  const leads = [];
  const spamContactIds = [];
  let newEngagementCount = 0;

  for (let start = 0; start < contacts.length; start += BATCH_SIZE) {
    const batch = contacts.slice(start, start + BATCH_SIZE);
    const batchNum = Math.floor(start / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(contacts.length / BATCH_SIZE);

    const engTasks = batch.map((c) => async () => {
      let skipIds = null;
      if (incremental) {
        skipIds = await getExistingEngagementIds(c.id);
      }
      const newEngs = await fetchEngagementsForContact(c.id, skipIds);
      if (newEngs.length > 0) {
        await upsertEngagementRows(c.id, newEngs).catch((err) =>
          console.warn(`[refresh] engagement DB write error for ${c.id}:`, err.message)
        );
        newEngagementCount += newEngs.length;
      }
      if (incremental && skipIds && skipIds.size > 0) {
        const allEngs = await getDbEngagementsForContact(c.id);
        return allEngs;
      }
      return newEngs;
    });
    const engResults = await withConcurrency(engTasks, ENGAGEMENT_CONCURRENCY);

    const procTasks = batch.map((contact, i) => async () => {
      const engs = engResults[i].status === "fulfilled" ? engResults[i].value : [];
      const lead = await processContact(contact, engs);
      lead.ownerName = await getOwnerName(lead.ownerId);
      return lead;
    });
    const processed = await withConcurrency(procTasks, PROCESS_CONCURRENCY);
    const batchLeads = [];
    const spamIds = [];
    for (const r of processed) {
      if (r.status === "fulfilled" && r.value) {
        if (r.value.isSpam) {
          spamIds.push(r.value.contactId);
        } else {
          batchLeads.push(r.value);
        }
      }
    }

    if (spamIds.length > 0) {
      console.log(`[refresh] Removing ${spamIds.length} spam contacts: ${spamIds.join(", ")}`);
      spamContactIds.push(...spamIds);
      await Promise.all(spamIds.map((id) => deleteLeadAndEngagements(id)));
    }

    await upsertLeadRows(batchLeads).catch((err) =>
      console.warn("[refresh] lead DB write error:", err.message)
    );
    leads.push(...batchLeads);

    for (let j = start; j < start + batch.length; j++) {
      contacts[j] = null;
    }

    console.log(
      `[refresh] Batch ${batchNum}/${totalBatches} done — ${leads.length}/${contacts.length} leads processed.`
    );
    if (batchNum % 5 === 0) {
      const m = process.memoryUsage();
      console.log(
        `[refresh] after batch ${batchNum} heap=${Math.round(m.heapUsed / 1048576)}MB rss=${Math.round(m.rss / 1048576)}MB`
      );
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  return { leads, newEngagementCount, spamContactIds };
}

async function _sweepSpamFromDb() {
  const client = getHubSpotClient();
  const cutoffDate = new Date("2026-01-01T00:00:00.000Z");
  const swept = [];

  try {
    let after = undefined;
    let spamIds = [];

    do {
      const response = await withRetry(() =>
        client.crm.contacts.searchApi.doSearch({
          filterGroups: [
            {
              filters: [
                { propertyName: "createdate", operator: "GTE", value: cutoffDate.getTime().toString() },
                { propertyName: "customer_type_2", operator: "EQ", value: "Spam" },
              ],
            },
          ],
          properties: ["firstname", "lastname"],
          limit: 100,
          after: after || 0,
        })
      );
      spamIds = spamIds.concat((response.results || []).map((c) => c.id));
      after = response.paging?.next?.after;
    } while (after);

    if (spamIds.length === 0) return swept;

    const { getPool } = require("./db");
    const pool = getPool();
    const dbResult = await pool.query(
      `SELECT contact_id FROM leads WHERE contact_id = ANY($1)`,
      [spamIds]
    );
    const toDelete = dbResult.rows.map((r) => r.contact_id);

    if (toDelete.length > 0) {
      console.log(`[spam-sweep] Found ${toDelete.length} spam contacts in DB, removing: ${toDelete.join(", ")}`);
      await Promise.all(toDelete.map((id) => deleteLeadAndEngagements(id)));
      swept.push(...toDelete);
    } else {
      console.log(`[spam-sweep] Checked ${spamIds.length} spam contacts in HubSpot — none in DB.`);
    }
  } catch (err) {
    console.warn("[spam-sweep] Error during spam sweep:", err.message);
  }

  return swept;
}

async function _fetchFromHubSpot({ forceFullRefresh = false } = {}) {
  const startedAt = Date.now();
  const syncWatermark = new Date(startedAt).toISOString();
  const logMem = (label) => {
    const m = process.memoryUsage();
    console.log(
      `[refresh] ${label} heap=${Math.round(m.heapUsed / 1048576)}MB rss=${Math.round(m.rss / 1048576)}MB`
    );
  };

  const syncState = forceFullRefresh ? null : await getSyncState();
  const isIncremental = !!syncState;
  const mode = isIncremental ? "Incremental" : "Full";
  const sweptSpamIds = [];

  console.log(`[refresh] ${mode} refresh starting...`);
  if (isIncremental) {
    console.log(`[refresh] Last sync: ${syncState.lastSyncAt} (${syncState.contactCount} contacts, ${syncState.engagementCount} engagements)`);
  }

  if (isIncremental) {
    const swept = await _sweepSpamFromDb();
    if (swept.length > 0) sweptSpamIds.push(...swept);
  }

  let contacts;
  if (isIncremental) {
    console.log(`[refresh] Fetching contacts modified since ${syncState.lastSyncAt}...`);
    contacts = await fetchModifiedContacts(syncState.lastSyncAt);
    console.log(`[refresh] Got ${contacts.length} modified contacts.`);
  } else {
    console.log("[refresh] Fetching all contacts from HubSpot...");
    contacts = await fetchAllContacts();
    console.log(`[refresh] Got ${contacts.length} contacts.`);
  }
  logMem("after contacts");

  const ownerIds = [
    ...new Set(contacts.map((c) => c.properties.hubspot_owner_id).filter(Boolean)),
  ];
  await Promise.all(ownerIds.map((id) => getOwnerName(id)));
  console.log(`[refresh] Resolved ${ownerIds.length} owner names.`);

  const { leads: processedLeads, newEngagementCount, spamContactIds } = await _processContactBatch(
    contacts,
    { incremental: isIncremental }
  );

  const customerLeads = processedLeads.filter((l) => l.isCustomer);
  if (customerLeads.length > 0) {
    console.log(`[refresh] Fetching conversion dates for ${customerLeads.length} customers...`);
    const conversionTasks = customerLeads.map((lead) => () =>
      fetchConversionDate(lead.contactId).then((date) => {
        lead.convertedAt = date || null;
        if (date && lead.createDate) {
          const msPerDay = 1000 * 60 * 60 * 24;
          lead.daysToConvert = Math.max(
            0,
            Math.round((new Date(date) - new Date(lead.createDate)) / msPerDay)
          );
        } else {
          lead.daysToConvert = null;
        }
      })
    );
    await withConcurrency(conversionTasks, 2);
    await upsertLeadRows(customerLeads).catch((err) =>
      console.warn("[refresh] customer lead DB update error:", err.message)
    );
  }

  let dbLeadCount = processedLeads.length;
  let dbEngCount = newEngagementCount;
  const dbCounts = await getDbLeadAndEngagementCounts();
  if (dbCounts) {
    dbLeadCount = dbCounts.leadCount;
    dbEngCount = dbCounts.engagementCount;
  }

  await setSyncState(dbLeadCount, dbEngCount, syncWatermark);

  let result;
  const existingCache = isIncremental ? getCached("allLeads") : null;
  const allSpamIds = [...spamContactIds, ...sweptSpamIds];
  const spamSet = new Set(allSpamIds);
  if (existingCache && (processedLeads.length > 0 || spamSet.size > 0)) {
    const updatedMap = new Map(processedLeads.map((l) => [l.contactId, l]));
    const patchedLeads = existingCache.leads
      .filter((l) => !spamSet.has(l.contactId))
      .map((l) => updatedMap.get(l.contactId) || l);
    for (const l of processedLeads) {
      if (!existingCache.leads.some((e) => e.contactId === l.contactId)) {
        patchedLeads.push(l);
      }
    }
    const byMarina = {};
    for (const l of patchedLeads) {
      const m = l.marina || "Unknown";
      if (!byMarina[m]) byMarina[m] = [];
      byMarina[m].push(l);
    }
    result = _applyRecompute({ leads: patchedLeads, byMarina });
  } else {
    const allData = await getAllLeadsFromDb();
    if (allData && allData.leads.length > 0) {
      result = _applyRecompute(allData);
    } else {
      const byMarina = {};
      for (const lead of processedLeads) {
        if (!byMarina[lead.marina]) byMarina[lead.marina] = [];
        byMarina[lead.marina].push(lead);
      }
      result = _applyRecompute({ leads: processedLeads, byMarina });
    }
  }

  setCache("allLeads", result);

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `[refresh] ${mode} refresh complete — ${processedLeads.length} contacts ${isIncremental ? "updated" : "processed"}, ${newEngagementCount} new engagements fetched in ${durationSec}s.`
  );
  logMem("after complete");
  return result;
}

module.exports = {
  getAllLeadsData,
  clearCache,
  getCacheStatus,
  forceRefresh,
  DISPOSITION_MAP,
  isMeaningfulResponse,
  isRepTouch,
  isInboundFromLead,
  isMissedInboundCall,
  getEmailSubtype,
  formatSpeedToLead,
  calcBusinessMinutes,
  getMarinaTimezone,
  isSpeedToLeadEligible,
  recomputeSpeedToLead,
};

// --- Utility: build form-fill "ask" summary from contact properties ---
function buildFormAsk(props) {
  const message = (props.additional_comments || props.customer_comments || props.message || "").trim();
  const inquiryType = (props.inquiry_type || props.type_of_inquiry || "").trim();
  const storageType = (props.storage_type || "").trim();
  const boatType = (props.boat_1_type || props.boat_type || "").trim();
  const boatModel = (props.boat_1_model || "").trim();
  const boatMake = (props.boat_make_1 || "").trim();
  const boatLoa = (props.boat_1_loa__in_feet_ || "").toString().trim();
  if (!message && !inquiryType && !storageType && !boatType && !boatModel && !boatMake && !boatLoa) {
    return null;
  }
  return {
    message: message || null,
    inquiryType: inquiryType || null,
    storageType: storageType || null,
    boatType: boatType || null,
    boatModel: boatModel || null,
    boatMake: boatMake || null,
    boatLoa: boatLoa || null,
  };
}

// --- Utility: format speed to lead ---
function formatSpeedToLead(minutes) {
  if (minutes === null || minutes === undefined) return "--";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}
