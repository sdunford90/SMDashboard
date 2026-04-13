const { getHubSpotClient } = require("./hubspot");
const { getDbCache, getDbCacheWithStale, setDbCache, clearDbCache } = require("./db");

// --- Disposition GUID to Label mapping ---
// Includes both generic HubSpot defaults and this portal's actual GUIDs
const DISPOSITION_MAP = {
  // Generic defaults
  "73a0d17f-1163-4015-bdd5-ec2c5a5d5291": "Connected",
  "17b3e3e6-df6c-4b33-a8a1-6e566efca55f": "Left Voicemail",
  "f240bbac-87c4-4d47-a50b-a6e4f95d1cc8": "No Answer",
  "a4c4c7d3-5a19-4571-9879-2f0e6c989fc5": "Busy",
  "45d5d02e-3a26-445a-b8cb-b4614c2d8193": "Wrong Number",
  // This portal's actual GUIDs (resolved from live data)
  "73a0d17f-1163-4015-bdd5-ec830791da20": "Connected",
  "f240bbac-87c9-4f6e-bf70-924b57d47db7": "No Answer",
  "a4c4c377-d246-4b32-a13b-75a56a4cd0ff": "Busy",
  "b2cf5968-551e-4856-9783-52b3da59a7d0": "Left Voicemail",
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

// --- Business hours speed to lead (Mon-Fri 9am-5pm Eastern Time) ---
function etDateStr(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date(ms));
}

function nextDateStr(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

function etHourToUTC(dateStr, hour) {
  const approx = new Date(`${dateStr}T${String(hour).padStart(2, "0")}:00:00Z`);
  const etHourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  }).format(approx);
  const etHour = parseInt(etHourStr.replace(/^24/, "0"));
  return approx.getTime() + (hour - etHour) * 3600000;
}

function calcBusinessMinutes(startMs, endMs) {
  if (!startMs || !endMs || endMs <= startMs) return 0;
  const BIZ_START_H = 9;
  const BIZ_END_H = 17;
  let total = 0;
  let dayStr = etDateStr(startMs);
  const lastDayStr = etDateStr(endMs);
  while (dayStr <= lastDayStr) {
    const dow = new Date(dayStr + "T12:00:00Z").getUTCDay(); // 0=Sun, 6=Sat
    if (dow >= 1 && dow <= 5) {
      const bizStart = etHourToUTC(dayStr, BIZ_START_H);
      const bizEnd = etHourToUTC(dayStr, BIZ_END_H);
      const overlapStart = Math.max(startMs, bizStart);
      const overlapEnd = Math.min(endMs, bizEnd);
      if (overlapEnd > overlapStart) {
        total += (overlapEnd - overlapStart) / 60000;
      }
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
    "recent_conversion_date",
    "recent_conversion_event_name",
    "first_conversion_date",
    "num_unique_conversion_events",
  ];

  const cutoffDate = new Date("2026-01-01T00:00:00.000Z");

  let allContacts = [];
  let after = undefined;

  do {
    const response = await withRetry(() =>
      client.crm.contacts.searchApi.doSearch({
        filterGroups: [
          {
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

// --- Process a single contact with engagements ---
function processContact(contact, engagements) {
  const props = contact.properties;
  const contactId = contact.id;
  const createDate = new Date(props.createdate);

  // Find first meaningful response
  const firstResponse = engagements.find((e) => isMeaningfulResponse(e));
  const firstResponseTime = firstResponse ? new Date(firstResponse.timestamp) : null;
  const speedToLeadMinutes = firstResponseTime
    ? (firstResponseTime - createDate) / (1000 * 60)
    : null;
  const speedToLeadBizMinutes = firstResponseTime
    ? calcBusinessMinutes(createDate.getTime(), firstResponseTime.getTime())
    : null;

  // Waiting on reply: last engagement is inbound from lead with no rep touch after it
  let waitingOnReply = false;
  let waitingSince = null;
  if (engagements.length > 0) {
    // Find last inbound from lead, check if any rep touch after it
    for (let i = engagements.length - 1; i >= 0; i--) {
      const e = engagements[i];
      if (isRepTouch(e)) break; // Most recent is a rep touch, not waiting
      if (isInboundFromLead(e)) {
        waitingOnReply = true;
        waitingSince = e.timestamp;
        break;
      }
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

  // Last touch
  const lastEngagement = engagements.length > 0 ? engagements[engagements.length - 1] : null;

  return {
    contactId,
    firstName: props.firstname || "",
    lastName: props.lastname || "",
    name: `${props.firstname || ""} ${props.lastname || ""}`.trim() || "Unknown",
    email: props.email || "",
    phone: props.phone || "",
    leadStatus: props.hs_lead_status || "",
    createDate: props.createdate,
    marina: (props.marina_location_2 || "Unknown").split(";")[0].trim(),
    ownerId: props.hubspot_owner_id || null,
    ownerName: null, // filled in later
    responded: !!firstResponse,
    firstResponseTime: firstResponseTime ? firstResponseTime.toISOString() : null,
    speedToLeadMinutes,
    speedToLeadBizMinutes,
    waitingOnReply,
    waitingSince,
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
    leadSource: (() => {
      const s1 = props.hs_analytics_source_data_1 || "";
      const src = props.hs_analytics_source || "";
      if (s1 === "CRM_UI") return "Call";
      if (props.recent_conversion_date) return "Web Form";
      if (s1.includes(".com") || s1.includes(".net") || s1.includes(".org") || s1.includes(".co")) return "Web Form";
      return "Digital";
    })(),
    hsSource: (() => {
      const src = props.hs_analytics_source || "";
      const s1 = props.hs_analytics_source_data_1 || "";
      if (s1 === "CRM_UI" || src === "CRM_UI") return "Call";
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
    recentFormDate: props.recent_conversion_date || null,
    recentFormName: props.recent_conversion_event_name || null,
    firstFormDate: props.first_conversion_date || null,
    numFormFills: props.num_unique_conversion_events ? parseInt(props.num_unique_conversion_events, 10) : 0,
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

// --- Background refresh trigger (won't block callers) ---
function _triggerBackgroundRefresh() {
  if (_inFlightFetch) return;
  console.log("[cache] Starting background refresh of HubSpot data...");
  _inFlightFetch = _fetchFromHubSpot().finally(() => { _inFlightFetch = null; });
}

// --- Main data fetcher ---
async function getAllLeadsData() {
  const cached = getCached("allLeads");
  if (cached) return cached;

  // Check persistent DB cache — serve even stale data immediately, refresh in background
  const dbEntry = await getDbCacheWithStale("allLeads");
  if (dbEntry) {
    setCache("allLeads", dbEntry.data);
    if (dbEntry.isStale) {
      console.log("[cache] Serving stale DB cache, triggering background refresh...");
      _triggerBackgroundRefresh();
    }
    return dbEntry.data;
  }

  if (_inFlightFetch) return _inFlightFetch;
  _inFlightFetch = _fetchFromHubSpot().finally(() => { _inFlightFetch = null; });
  return _inFlightFetch;
}

// --- Actual HubSpot fetch (used by warmup and stale-while-revalidate) ---
async function _fetchFromHubSpot() {
  const contacts = await fetchAllContacts();

  // Fetch engagements for all contacts with concurrency limit
  const tasks = contacts.map((contact) => () => fetchEngagementsForContact(contact.id));
  const engagementResults = await withConcurrency(tasks, 2);

  // Collect unique owner IDs and resolve names
  const ownerIds = [...new Set(contacts.map((c) => c.properties.hubspot_owner_id).filter(Boolean))];
  await Promise.all(ownerIds.map((id) => getOwnerName(id)));

  // Process each contact
  const leads = [];
  for (let i = 0; i < contacts.length; i++) {
    const engs =
      engagementResults[i].status === "fulfilled"
        ? engagementResults[i].value
        : [];
    const lead = processContact(contacts[i], engs);
    lead.ownerName = await getOwnerName(lead.ownerId);
    leads.push(lead);
  }

  // Fetch conversion timestamps for customer contacts (concurrency-limited)
  const customerLeads = leads.filter((l) => l.isCustomer);
  if (customerLeads.length > 0) {
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

  // Group by marina
  const byMarina = {};
  for (const lead of leads) {
    if (!byMarina[lead.marina]) byMarina[lead.marina] = [];
    byMarina[lead.marina].push(lead);
  }

  const result = { leads, byMarina };
  setCache("allLeads", result);
  setDbCache("allLeads", result).catch(() => {});
  console.log("[cache] HubSpot data refreshed and cached.");
  return result;
}

module.exports = {
  getAllLeadsData,
  clearCache,
  DISPOSITION_MAP,
  isMeaningfulResponse,
  isRepTouch,
  isInboundFromLead,
  isMissedInboundCall,
  getEmailSubtype,
  formatSpeedToLead,
};

// --- Utility: format speed to lead ---
function formatSpeedToLead(minutes) {
  if (minutes === null || minutes === undefined) return "--";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}
