import { getAllLeadsData, getEmailSubtype } from "../../../lib/leads";

export default async function handler(req, res) {
  const { id } = req.query;

  try {
    const { leads } = await getAllLeadsData();
    const lead = leads.find((l) => l.contactId === id);

    if (!lead) {
      return res.status(404).json({ error: "Lead not found" });
    }

    // Build detailed engagement timeline
    const ackEngId = lead.lastInboundEngagementId;
    const ackTs = lead.lastInboundTimestamp;
    const timeline = lead.engagements.map((eng) => {
      const isAckTarget = lead.lastInboundIsAck && (
        (ackEngId && (eng.id === ackEngId || eng.engagementId === ackEngId)) ||
        (!ackEngId && ackTs && eng.timestamp === ackTs && eng.type === "EMAIL")
      );
      if (eng.type === "EMAIL") {
        const subtype = getEmailSubtype(eng);
        return {
          type: "EMAIL",
          subtype,
          direction: eng.direction,
          timestamp: eng.timestamp,
          subject: eng.subject,
          bodyPreview: eng.bodyPreview || "",
          sentBy: eng.sentBy,
          loggedFrom: eng.loggedFrom,
          isAutomated: eng.emailType === "AUTOMATED",
          actorName: eng.ownerName || null,
          label:
            subtype === "EMAIL_INBOUND"
              ? "Inbound Email"
              : subtype === "EMAIL_LOGGED"
              ? "Logged Email"
              : eng.emailType === "AUTOMATED"
              ? "Automated Email"
              : "Sent Email",
          isAcknowledgment: isAckTarget || false,
          ackReason: isAckTarget ? lead.lastInboundAckReason : null,
        };
      }
      if (eng.type === "NOTE") {
        return {
          type: "NOTE",
          subtype: "NOTE",
          timestamp: eng.timestamp,
          notes: eng.body || "",
          actorName: eng.ownerName || null,
          label: "Note",
        };
      }
      return {
        type: "CALL",
        subtype: eng.direction === "INBOUND" ? "INBOUND_CALL" : "OUTBOUND_CALL",
        direction: eng.direction,
        timestamp: eng.timestamp,
        disposition: eng.disposition,
        durationMs: eng.durationMilliseconds || 0,
        durationFormatted: eng.durationMilliseconds
          ? formatDuration(eng.durationMilliseconds)
          : null,
        notes: eng.body || "",
        recordingUrl: eng.recordingUrl,
        isLogged: eng.isLogged || false,
        actorName: eng.ownerName || null,
        label:
          eng.direction === "INBOUND"
            ? `Inbound Call -- ${eng.disposition}`
            : `${eng.isLogged ? "Logged Call" : "Outbound Call"} -- ${eng.disposition}`,
      };
    });

    res.status(200).json({
      contactId: lead.contactId,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      marina: lead.marina,
      ownerName: lead.ownerName,
      createDate: lead.createDate,
      hubspotUrl: lead.hubspotUrl,
      responded: lead.responded,
      speedToLeadMinutes: lead.speedToLeadMinutes,
      waitingOnReply: lead.waitingOnReply,
      lastInboundIsAck: lead.lastInboundIsAck || false,
      lastInboundAckReason: lead.lastInboundAckReason || null,
      hasMissedInbound: lead.hasMissedInbound,
      timeline,
      aiSummary: null,
    });
  } catch (error) {
    console.error("Error fetching lead detail:", error);
    res.status(500).json({ error: "Failed to fetch lead detail" });
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
