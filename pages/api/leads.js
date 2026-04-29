import { getAllLeadsData, formatSpeedToLead } from "../../lib/leads";

// Synthesize firstResponse object from cached engagements when the cached
// lead pre-dates the firstResponse field rollout (only relevant for
// rep-initiated sources where recomputeSpeedToLead doesn't run; Web Form /
// Digital leads always have firstResponse re-derived in getAllLeadsData).
function deriveFirstResponse(lead) {
  if (lead.firstResponse) return lead.firstResponse;
  if (!lead.responded || !lead.firstResponseTime) return null;
  const engs = lead.engagements || [];
  const targetMs = new Date(lead.firstResponseTime).getTime();
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
    // getAllLeadsData() applies recomputeSpeedToLead centrally, so
    // responded / firstResponseTime / speedToLead* / firstResponse are
    // already up-to-date with the current rules — no per-endpoint override
    // needed. See lib/leads.js _applyRecompute / recomputeSpeedToLead.
    const { leads } = await getAllLeadsData();

    const result = leads.map((lead) => ({
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
      responded: lead.responded,
      firstResponseTime: lead.firstResponseTime,
      speedToLeadMinutes: lead.speedToLeadMinutes,
      speedToLeadFormatted: formatSpeedToLead(lead.speedToLeadMinutes),
      speedToLeadBizMinutes: lead.speedToLeadBizMinutes,
      speedToLeadBizFormatted: formatSpeedToLead(lead.speedToLeadBizMinutes),
      speedIsPending: !!lead.speedIsPending,
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
      firstResponse: deriveFirstResponse(lead),
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
        : lead.responded
        ? "Responded"
        : "Never Responded",
    }));

    res.status(200).json({ leads: result, total: result.length });
  } catch (error) {
    console.error("Error fetching leads:", error);
    res.status(500).json({ error: "Failed to fetch leads" });
  }
}
