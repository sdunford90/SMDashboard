const { getHubSpotClient } = require("./hubspot");
const { getDbCache, setDbCache, clearDbCache } = require("./db");

// --- Disposition GUID to Label mapping ---
const DISPOSITION_MAP = {
  "73a0d17f-1163-4015-bdd5-ec2c5a5d5291": "Connected",
  "17b3e3e6-df6c-4b33-a8a1-6e566efca55f": "Left Voicemail",
  "f240bbac-87c4-4d47-a50b-a6e4f95d1cc8": "No Answer",
  "a4c4c7d3-5a19-4571-9879-2f0e6c989fc5": "Busy",
  "45d5d02e-3a26-445a-b8cb-b4614c2d8193": "Wrong Number",
};

// --- In-memory cache with 5-minute TTL ---
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

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

// --- Fetch contacts created in last 30 days ---
async function fetchAllContacts() {
  const client = getHubSpotClient();
  const properties = [
    "firstname",
    "lastname",
    "email",
    "hs_lead_status",
    "createdate",
    "marina_location",
    "hubspot_owner_id",
    "phone",
  ];

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  let allContacts = [];
  let after = undefined;

  do {
    const response = await client.crm.contacts.searchApi.doSearch({
      filterGroups: [
        {
          filters: [
            {
              propertyName: "createdate",
              operator: "GTE",
              value: thirtyDaysAgo.getTime().toString(),
            },
          ],
        },
      ],
      properties,
      limit: 100,
      after: after || 0,
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
    });
    allContacts = allContacts.concat(response.results || []);
    after = response.paging?.next?.after;
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
      const resp = await client.crm.objects.associationsApi.getAll(
        "contacts",
        contactId,
        "emails",
        after ? 100 : 100,
        after
      );
      if (resp.results) {
        for (const assoc of resp.results) {
          try {
            const email = await client.crm.objects.emails.basicApi.getById(
              assoc.id,
              [
                "hs_email_direction",
                "hs_email_status",
                "hs_email_subject",
                "hs_timestamp",
                "hs_email_sender_email",
                "hs_email_logged_from",
                "hs_email_type",
                "hs_email_text",
              ]
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
      const resp = await client.crm.objects.associationsApi.getAll(
        "contacts",
        contactId,
        "calls",
        after ? 100 : 100,
        after
      );
      if (resp.results) {
        for (const assoc of resp.results) {
          try {
            const call = await client.crm.objects.calls.basicApi.getById(
              assoc.id,
              [
                "hs_call_direction",
                "hs_call_disposition",
                "hs_call_duration",
                "hs_call_body",
                "hs_call_recording_url",
                "hs_timestamp",
                "hubspot_owner_id",
              ]
            );
            const props = call.properties;
            const dispositionGuid = props.hs_call_disposition || "";
            engagements.push({
              type: "CALL",
              direction: (props.hs_call_direction || "").toUpperCase() || "UNKNOWN",
              disposition: DISPOSITION_MAP[dispositionGuid] || dispositionGuid || "Unknown",
              dispositionRaw: dispositionGuid,
              durationMilliseconds: parseInt(props.hs_call_duration || "0", 10),
              body: props.hs_call_body || "",
              recordingUrl: props.hs_call_recording_url || null,
              timestamp: props.hs_timestamp || call.createdAt,
              ownerId: props.hubspot_owner_id || null,
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
  if (engagement.direction === "INCOMING" || engagement.direction === "INBOUND") {
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
    if (dir !== "OUTGOING" && dir !== "OUTBOUND" && dir !== "FORWARDED_EMAIL") return false;
    if (engagement.emailType === "AUTOMATED") return false;
    return true;
  }
  if (engagement.type === "CALL") {
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
    return (dir === "OUTGOING" || dir === "OUTBOUND" || dir === "FORWARDED_EMAIL") &&
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
    return engagement.direction === "INCOMING" || engagement.direction === "INBOUND";
  }
  if (engagement.type === "CALL") {
    return engagement.direction === "INBOUND" && engagement.disposition === "Connected";
  }
  return false;
}

// --- Check if a call is a missed inbound ---
function isMissedInboundCall(engagement) {
  return (
    engagement.type === "CALL" &&
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
    marina: props.marina_location || "Unknown",
    ownerId: props.hubspot_owner_id || null,
    ownerName: null, // filled in later
    responded: !!firstResponse,
    firstResponseTime: firstResponseTime ? firstResponseTime.toISOString() : null,
    speedToLeadMinutes,
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
    engagements,
    hubspotUrl: `https://app.hubspot.com/contacts/${process.env.HUBSPOT_PORTAL_ID || "PORTAL_ID"}/contact/${contactId}`,
  };
}

// --- In-flight deduplication: all concurrent callers share one fetch ---
let _inFlightFetch = null;

// --- Main data fetcher ---
async function getAllLeadsData() {
  const cached = getCached("allLeads");
  if (cached) return cached;

  // Check persistent DB cache (survives server restarts)
  const dbCached = await getDbCache("allLeads");
  if (dbCached) {
    setCache("allLeads", dbCached);
    return dbCached;
  }

  if (_inFlightFetch) return _inFlightFetch;

  _inFlightFetch = (async () => {
  const contacts = await fetchAllContacts();

  // Fetch engagements for all contacts with concurrency limit
  const tasks = contacts.map((contact) => () => fetchEngagementsForContact(contact.id));
  const engagementResults = await withConcurrency(tasks, 5);

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

  // Group by marina
  const byMarina = {};
  for (const lead of leads) {
    if (!byMarina[lead.marina]) byMarina[lead.marina] = [];
    byMarina[lead.marina].push(lead);
  }

  const result = { leads, byMarina };
  setCache("allLeads", result);
  setDbCache("allLeads", result).catch(() => {});
  return result;
  })().finally(() => { _inFlightFetch = null; });

  return _inFlightFetch;
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
