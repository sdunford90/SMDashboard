const { getHubSpotClient } = require("./hubspot");
const { getDbCache, getDbCacheWithStale, setDbCache, clearDbCache, getDbCacheMeta } = require("./db");

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

function forceRefresh() {
  cache.delete("allLeads");
  if (_inFlightFetch) return _inFlightFetch;
  console.log("[cache] Force refresh triggered.");
  _inFlightFetch = _fetchFromHubSpot().finally(() => { _inFlightFetch = null; });
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

// 9am–5pm in the marina's local timezone, 7 days a week
function calcBusinessMinutes(startMs, endMs, tz = DEFAULT_TZ) {
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

// --- Fetch engagements for a single contact ---
async function fetchEngagementsForContact(contactId) {
  const client = getHubSpotClient();
  const engagements = [];

  // Fetch EMAIL engagements
  try {
    let after = undefined;
    do {
      const resp = await withRetry(() =>
        client.crm.associations.v4.basicApi.getPage(
          "contacts",
          contactId,
          "emails",
          after,
          100
        )
      );
      if (resp.results) {
        for (const assoc of resp.results) {
          try {
            const email = await withRetry(() =>
              client.crm.objects.emails.basicApi.getById(assoc.toObjectId, [
                "hs_email_direction",
                "hs_email_status",
                "hs_email_subject",
                "hs_timestamp",
                "hs_email_sender_email",
                "hs_email_logged_from",
                "hs_email_type",
                "hs_email_text",
                "hubspot_owner_id",
              ])
            );
            const props = email.properties;
            engagements.push({
              type: "EMAIL",
              direction: props.hs_email_direction || "UNKNOWN",
              emailType: props.hs_email_type || null,
              sentBy: props.hs_email_sender_email || null,
              subject: props.hs_email_subject || "",
              timestamp: props.hs_timestamp || email.createdAt,
              loggedFrom: props.hs_email_logged_from || null,
              bodyPreview: (props.hs_email_text || "").slice(0, 500),
              engagementId: email.id,
              ownerId: props.hubspot_owner_id || null,
            });
          } catch {
            // Skip individual email fetch errors
          }
        }
      }
      after = resp.paging?.next?.after;
    } while (after);
  } catch {
    // No email associations
  }

  // Fetch CALL engagements
  try {
    let after = undefined;
    do {
      const resp = await withRetry(() =>
        client.crm.associations.v4.basicApi.getPage(
          "contacts",
          contactId,
          "calls",
          after,
          100
        )
      );
      if (resp.results) {
        for (const assoc of resp.results) {
          try {
            const call = await withRetry(() =>
              client.crm.objects.calls.basicApi.getById(assoc.toObjectId, [
                "hs_call_direction",
                "hs_call_disposition",
                "hs_call_duration",
                "hs_call_body",
                "hs_call_recording_url",
                "hs_timestamp",
                "hubspot_owner_id",
                "hs_call_source",
                "hs_call_is_logged",
              ])
            );
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
            engagements.push({
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
            });
          } catch {
            // Skip individual call fetch errors
          }
        }
      }
      after = resp.paging?.next?.after;
    } while (after);
  } catch {
    // No call associations
  }

  // Fetch NOTE engagements
  try {
    let after = undefined;
    do {
      const resp = await withRetry(() =>
        client.crm.associations.v4.basicApi.getPage(
          "contacts",
          contactId,
          "notes",
          after,
          100
        )
      );
      if (resp.results) {
        for (const assoc of resp.results) {
          try {
            const note = await withRetry(() =>
              client.crm.objects.notes.basicApi.getById(assoc.toObjectId, [
                "hs_note_body",
                "hs_timestamp",
                "hubspot_owner_id",
              ])
            );
            const props = note.properties;
            const body = stripHtml(props.hs_note_body || "").trim();
            if (!body) continue; // skip empty notes
            engagements.push({
              type: "NOTE",
              timestamp: props.hs_timestamp || note.createdAt,
              body,
              ownerId: props.hubspot_owner_id || null,
              engagementId: note.id,
            });
          } catch {
            // Skip individual note fetch errors
          }
        }
      }
      after = resp.paging?.next?.after;
    } while (after);
  } catch {
    // No note associations
  }

  // Fetch MEETING engagements
  try {
    let after = undefined;
    do {
      const resp = await withRetry(() =>
        client.crm.associations.v4.basicApi.getPage(
          "contacts",
          contactId,
          "meetings",
          after,
          100
        )
      );
      if (resp.results) {
        for (const assoc of resp.results) {
          try {
            const meeting = await withRetry(() =>
              client.crm.objects.meetings.basicApi.getById(assoc.toObjectId, [
                "hs_meeting_title",
                "hs_meeting_body",
                "hs_meeting_start_time",
                "hs_meeting_end_time",
                "hs_meeting_outcome",
                "hs_timestamp",
                "hubspot_owner_id",
                "hs_activity_type",
              ])
            );
            const props = meeting.properties;
            // Use the moment the meeting was *logged* (object createdAt) as
            // the response timestamp — that's when the rep took the action.
            // Using hs_meeting_start_time would push speed-to-lead out into
            // the future for meetings scheduled days ahead.
            const ts =
              meeting.createdAt ||
              props.hs_timestamp ||
              props.hs_meeting_start_time;
            engagements.push({
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
            });
          } catch {
            // Skip individual meeting fetch errors
          }
        }
      }
      after = resp.paging?.next?.after;
    } while (after);
  } catch {
    // No meeting associations
  }

  // Resolve owner names for all engagements that have an ownerId
  const uniqueOwnerIds = [...new Set(engagements.filter((e) => e.ownerId).map((e) => e.ownerId))];
  await Promise.all(uniqueOwnerIds.map((id) => getOwnerName(id)));
  for (const eng of engagements) {
    if (eng.ownerId) eng.ownerName = ownerCache.get(eng.ownerId) || null;
  }

  // Sort by timestamp ascending
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
  //   (call, email, meeting) at or after createDate. A 30-minute grace
  //   window absorbs clock skew between HubSpot's form-submission timestamp
  //   and an immediate auto-logged response. Returning customers' legacy
  //   engagements (months/years before this lead) are excluded.
  const repInitiated = leadSource === "Call" || isWalkIn || leadSource === "Referral";
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
    const RESPONSE_GRACE_MS = 30 * 60 * 1000;
    const earliestAllowed = new Date(createDate.getTime() - RESPONSE_GRACE_MS);
    firstResponse = engagements.find((e) => {
      const ts = e.timestamp ? new Date(e.timestamp) : null;
      if (!ts || isNaN(ts.getTime()) || ts < earliestAllowed) return false;
      return isMeaningfulResponse(e);
    });
  }
  // Anchor firstResponseTime at createDate at the earliest — for repInitiated
  // leads the inbound interaction often predates createDate, but speed-to-lead
  // can never be negative (the rep can't respond before the lead exists).
  const rawResponseTime = firstResponse ? new Date(firstResponse.timestamp) : null;
  const firstResponseTime = rawResponseTime
    ? new Date(Math.max(rawResponseTime.getTime(), createDate.getTime()))
    : null;
  let speedToLeadMinutes = firstResponseTime
    ? (firstResponseTime - createDate) / (1000 * 60)
    : null;
  let speedToLeadBizMinutes = firstResponseTime
    ? calcBusinessMinutes(createDate.getTime(), firstResponseTime.getTime(), tz)
    : null;

  // Pending elapsed-clock fallback for non-responded, non-walk-in leads.
  // Counts business minutes from createDate to "now" (this cache snapshot),
  // capped at 7 business days. Locked to the real response time the moment
  // a firm response is logged. Walk-ins are excluded — their "response" is
  // a NOTE and reps are inconsistent about logging notes.
  let speedIsPending = false;
  if (!firstResponseTime && !isWalkIn && createDate) {
    // Even if elapsed business minutes is 0 (lead created off-hours and no
    // biz time has accrued yet), set the value to 0 so the lead is included
    // in the running average from the moment it's created.
    const elapsedBiz = calcBusinessMinutes(createDate.getTime(), Date.now(), tz);
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
async function getAllLeadsData() {
  const cached = getCached("allLeads");
  if (cached) return cached;

  const dbEntry = await getDbCacheWithStale("allLeads");
  if (dbEntry) {
    setCache("allLeads", dbEntry.data);
    return dbEntry.data;
  }

  // Cold cache: return an empty shape so the dashboard renders. The user
  // can populate the cache by clicking refresh.
  return { leads: [], byMarina: {} };
}

// --- Actual HubSpot fetch (used by /api/refresh) ---
//
// Refresh is batched to keep memory bounded so the small production VM
// (0.5 vCPU / 2 GB RAM) doesn't OOM mid-refresh. We fetch contacts once,
// then walk the contact list in BATCH_SIZE chunks: for each chunk we
// fetch engagements, process them into lead objects, append to the
// running result, and let the engagement payloads be garbage-collected
// before moving on. Progress is logged after every batch so we can see
// exactly where a refresh is at if it stalls.
async function _fetchFromHubSpot() {
  const startedAt = Date.now();
  const logMem = (label) => {
    const m = process.memoryUsage();
    console.log(
      `[refresh] ${label} heap=${Math.round(m.heapUsed / 1048576)}MB rss=${Math.round(m.rss / 1048576)}MB`
    );
  };

  console.log("[refresh] Fetching contacts from HubSpot...");
  const contacts = await fetchAllContacts();
  console.log(`[refresh] Got ${contacts.length} contacts.`);
  logMem("after contacts");

  // Resolve owner names up front (cheap, dedup'd internally).
  const ownerIds = [
    ...new Set(contacts.map((c) => c.properties.hubspot_owner_id).filter(Boolean)),
  ];
  await Promise.all(ownerIds.map((id) => getOwnerName(id)));
  console.log(`[refresh] Resolved ${ownerIds.length} owner names.`);

  const BATCH_SIZE = 100;
  const ENGAGEMENT_CONCURRENCY = 2;
  const PROCESS_CONCURRENCY = 4;
  const leads = [];

  for (let start = 0; start < contacts.length; start += BATCH_SIZE) {
    const batch = contacts.slice(start, start + BATCH_SIZE);
    const batchNum = Math.floor(start / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(contacts.length / BATCH_SIZE);

    // Fetch engagements for this batch only.
    const engTasks = batch.map((c) => () => fetchEngagementsForContact(c.id));
    const engResults = await withConcurrency(engTasks, ENGAGEMENT_CONCURRENCY);

    // Process this batch into lead objects.
    const procTasks = batch.map((contact, i) => async () => {
      const engs = engResults[i].status === "fulfilled" ? engResults[i].value : [];
      const lead = await processContact(contact, engs);
      lead.ownerName = await getOwnerName(lead.ownerId);
      return lead;
    });
    const processed = await withConcurrency(procTasks, PROCESS_CONCURRENCY);
    for (const r of processed) {
      if (r.status === "fulfilled" && r.value) leads.push(r.value);
    }

    console.log(
      `[refresh] Batch ${batchNum}/${totalBatches} done — ${leads.length}/${contacts.length} leads processed.`
    );
    if (batchNum % 5 === 0) logMem(`after batch ${batchNum}`);
  }

  // Conversion dates for customer leads (cheap — only ~100 contacts).
  const customerLeads = leads.filter((l) => l.isCustomer);
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
  }

  // Group by marina.
  const byMarina = {};
  for (const lead of leads) {
    if (!byMarina[lead.marina]) byMarina[lead.marina] = [];
    byMarina[lead.marina].push(lead);
  }

  const result = { leads, byMarina };
  setCache("allLeads", result);
  setDbCache("allLeads", result).catch((err) =>
    console.error("[refresh] DB cache write failed:", err.message)
  );
  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`[refresh] Complete — ${leads.length} leads cached in ${durationSec}s.`);
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
