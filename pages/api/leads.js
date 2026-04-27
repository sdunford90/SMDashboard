import { getAllLeadsData, formatSpeedToLead, calcBusinessMinutes, getMarinaTimezone } from "../../lib/leads";

// Recompute speed-to-lead at the API layer when the cached lead pre-dates
// the "anchor at most-recent form fill" fix. For Web Form / Digital leads
// whose recentFormDate is more recent than createDate (returning customer
// re-engagement), find the first meaningful response at or after that
// anchor and recompute STL. This avoids a stale 8000-hour STL number on
// returning-customer leads while waiting for the next refresh.
function isMeaningful(e) {
  if (!e) return false;
  if (e.type === "MEETING") return true;
  if (e.type === "EMAIL") {
    const dir = e.direction;
    if (dir !== "OUTGOING" && dir !== "OUTBOUND" && dir !== "FORWARDED_EMAIL" && dir !== "EMAIL") return false;
    if (e.emailType === "AUTOMATED") return false;
    return true;
  }
  if (e.type === "CALL") {
    if (e.isLogged) return true;
    if (e.direction === "OUTBOUND") {
      return e.disposition === "Connected" || e.disposition === "Left Voicemail";
    }
    if (e.direction === "INBOUND") {
      return e.disposition === "Connected";
    }
  }
  return false;
}
function deriveSpeedToLead(lead) {
  const repInitiated = lead.leadSource === "Call" || lead.leadSource === "Walk-in" || lead.leadSource === "Referral";
  if (repInitiated) return null; // use cached values
  if (!lead.recentFormDate || !lead.createDate) return null;
  const anchor = new Date(lead.recentFormDate);
  const created = new Date(lead.createDate);
  if (!(anchor.getTime() > created.getTime())) return null; // not a returning lead
  const engs = lead.engagements || [];
  const GRACE_MS = 30 * 60 * 1000;
  const earliest = anchor.getTime() - GRACE_MS;
  const fr = engs.find((e) => {
    if (!e.timestamp) return false;
    if (new Date(e.timestamp).getTime() < earliest) return false;
    return isMeaningful(e);
  });
  const tz = getMarinaTimezone(lead.marina);
  if (!fr) {
    // No qualifying response → recompute pending elapsed clock from anchor.
    const elapsedBiz = calcBusinessMinutes(anchor.getTime(), Date.now(), tz);
    return {
      responded: false,
      firstResponseTime: null,
      speedToLeadMinutes: null,
      speedToLeadBizMinutes: Math.min(Math.max(elapsedBiz, 0), 7 * 8 * 60),
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

// Synthesize firstResponse object from cached engagements when the cached
// lead pre-dates the firstResponse field rollout (avoids requiring a full
// HubSpot refresh for the new All Leads columns to render).
function deriveFirstResponse(lead) {
  if (lead.firstResponse) return lead.firstResponse;
  if (!lead.responded || !lead.firstResponseTime) return null;
  const engs = lead.engagements || [];
  const targetMs = new Date(lead.firstResponseTime).getTime();
  // Pick the engagement closest to firstResponseTime that is a meaningful response type.
  let best = null;
  let bestDelta = Infinity;
  for (const e of engs) {
    if (!e.timestamp) continue;
    if (e.type !== "EMAIL" && e.type !== "CALL" && e.type !== "MEETING" && e.type !== "NOTE") continue;
    const delta = Math.abs(new Date(e.timestamp).getTime() - targetMs);
    if (delta < bestDelta) {
      best = e;
      bestDelta = delta;
    }
  }
  if (!best) {
    return { type: "SYNTHETIC", subtype: "SYNTHETIC", timestamp: lead.firstResponseTime, disposition: null, synthetic: true };
  }
  let subtype = null;
  if (best.type === "EMAIL") {
    const dir = best.direction;
    if (dir === "INCOMING" || dir === "INBOUND" || dir === "INCOMING_EMAIL") subtype = "EMAIL_INBOUND";
    else if (best.loggedFrom === "CRM") subtype = "EMAIL_LOGGED";
    else subtype = "EMAIL_SENT";
  } else if (best.type === "CALL") {
    subtype = best.direction === "INBOUND" ? "INBOUND_CALL" : "OUTBOUND_CALL";
  } else {
    subtype = best.type;
  }
  return {
    type: best.type,
    subtype,
    timestamp: best.timestamp,
    disposition: best.disposition || null,
    synthetic: false,
  };
}

export default async function handler(req, res) {
  try {
    const { leads } = await getAllLeadsData();

    const result = leads.map((lead) => {
      const stlOverride = deriveSpeedToLead(lead);
      const responded = stlOverride ? stlOverride.responded : lead.responded;
      const firstResponseTime = stlOverride ? stlOverride.firstResponseTime : lead.firstResponseTime;
      const speedToLeadMinutes = stlOverride ? stlOverride.speedToLeadMinutes : lead.speedToLeadMinutes;
      const speedToLeadBizMinutes = stlOverride ? stlOverride.speedToLeadBizMinutes : lead.speedToLeadBizMinutes;
      const speedIsPending = stlOverride ? stlOverride.speedIsPending : !!lead.speedIsPending;
      const firstResponse = stlOverride && stlOverride.firstResponse !== undefined
        ? stlOverride.firstResponse
        : deriveFirstResponse(lead);
      return {
      contactId: lead.contactId,
      name: lead.name,
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      phone: lead.phone,
      leadStatus: lead.leadStatus,
      createDate: lead.createDate,
      marina: lead.marina,
      ownerName: lead.ownerName,
      responded,
      firstResponseTime,
      speedToLeadMinutes,
      speedToLeadFormatted: formatSpeedToLead(speedToLeadMinutes),
      speedToLeadBizMinutes,
      speedToLeadBizFormatted: formatSpeedToLead(speedToLeadBizMinutes),
      speedIsPending,
      waitingOnReply: lead.waitingOnReply,
      waitingSince: lead.waitingSince,
      hasMissedInbound: lead.hasMissedInbound,
      missedCallTime: lead.missedCallTime,
      emailsSent: lead.emailsSent,
      emailsLogged: lead.emailsLogged,
      callsOutbound: lead.callsOutbound,
      callsInbound: lead.callsInbound,
      callsConnected: lead.callsConnected,
      callsLogged: lead.callsLogged,
      callsLoggedWithNotes: lead.callsLoggedWithNotes || 0,
      lastTouch: lead.lastTouch,
      firstResponse,
      lastLeadActivityAt: lead.lastLeadActivityAt,
      hubspotUrl: lead.hubspotUrl,
      leadSource: lead.leadSource,
      recentFormDate: lead.recentFormDate || null,
      recentFormName: lead.recentFormName || null,
      firstFormDate: lead.firstFormDate || null,
      numFormFills: lead.numFormFills || 0,
      isCustomer: lead.isCustomer,
      convertedAt: lead.convertedAt || null,
      daysToConvert: lead.daysToConvert !== undefined ? lead.daysToConvert : null,
      status: lead.isCustomer
        ? "Converted"
        : lead.hasMissedInbound
        ? "Missed Call"
        : lead.waitingOnReply
        ? "Waiting on Reply"
        : responded
        ? "Responded"
        : "Never Responded",
      };
    });

    res.status(200).json({ leads: result, total: result.length });
  } catch (error) {
    console.error("Error fetching leads:", error);
    res.status(500).json({ error: "Failed to fetch leads" });
  }
}
