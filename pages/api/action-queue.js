import { getAllLeadsData } from "../../lib/leads";

export default async function handler(req, res) {
  try {
    const { leads } = await getAllLeadsData();
    const now = new Date();

    // Category 1: Missed inbound calls with no follow-up
    const missedCalls = leads
      .filter((l) => l.hasMissedInbound)
      .map((l) => ({
        ...formatLead(l),
        category: "missed_inbound",
        priority: 1,
        missedCallTime: l.missedCallTime,
        attempts: l.missedCallAttempts,
        waitMinutes: (now - new Date(l.missedCallTime)) / (1000 * 60),
      }))
      .sort((a, b) => b.waitMinutes - a.waitMinutes);

    // Category 2: Waiting on reply
    const waitingOnReply = leads
      .filter((l) => l.waitingOnReply && !l.hasMissedInbound)
      .map((l) => ({
        ...formatLead(l),
        category: "waiting_on_reply",
        priority: 2,
        waitingSince: l.waitingSince,
        lastInboundType: l.lastTouch?.subtype || "unknown",
        waitMinutes: l.waitingSince
          ? (now - new Date(l.waitingSince)) / (1000 * 60)
          : 0,
      }))
      .sort((a, b) => b.waitMinutes - a.waitMinutes);

    // Category 3: 3+ no-answer outbound attempts with no connection
    const multipleNoAnswer = leads
      .filter(
        (l) =>
          l.noAnswerOutboundCount >= 3 &&
          l.callsConnected === 0 &&
          !l.hasMissedInbound &&
          !l.waitingOnReply
      )
      .map((l) => ({
        ...formatLead(l),
        category: "multiple_no_answer",
        priority: 3,
        noAnswerCount: l.noAnswerOutboundCount,
        waitMinutes: (now - new Date(l.createDate)) / (1000 * 60),
      }))
      .sort((a, b) => b.waitMinutes - a.waitMinutes);

    // Category 4: Never responded
    const neverResponded = leads
      .filter(
        (l) =>
          !l.responded &&
          !l.hasMissedInbound &&
          !l.waitingOnReply &&
          l.noAnswerOutboundCount < 3
      )
      .map((l) => ({
        ...formatLead(l),
        category: "never_responded",
        priority: 4,
        waitMinutes: (now - new Date(l.createDate)) / (1000 * 60),
      }))
      .sort((a, b) => b.waitMinutes - a.waitMinutes);

    // All unresponded: every lead where rep has not yet made a meaningful response
    const allUnresponded = leads
      .filter((l) => !l.responded)
      .map((l) => {
        const ageMs = now - new Date(l.createDate);
        const ageMinutes = ageMs / (1000 * 60);
        const ageHours = ageMinutes / 60;
        const ageDays = Math.floor(ageHours / 24);
        let urgency;
        if (ageHours < 1) urgency = "low";
        else if (ageHours < 4) urgency = "medium";
        else if (ageHours < 24) urgency = "high";
        else urgency = "critical";
        return {
          ...formatLead(l),
          ageMinutes,
          ageDays,
          urgency,
          hasMissedInbound: l.hasMissedInbound,
          waitingOnReply: l.waitingOnReply,
          callsOutbound: l.callsOutbound,
          callsInbound: l.callsInbound,
          emailsSent: l.emailsSent,
          lastTouch: l.lastTouch,
        };
      })
      .sort((a, b) => b.ageMinutes - a.ageMinutes);

    res.status(200).json({
      missedCalls,
      waitingOnReply,
      multipleNoAnswer,
      neverResponded,
      allUnresponded,
      counts: {
        missedCalls: missedCalls.length,
        waitingOnReply: waitingOnReply.length,
        multipleNoAnswer: multipleNoAnswer.length,
        neverResponded: neverResponded.length,
        allUnresponded: allUnresponded.length,
      },
    });
  } catch (error) {
    console.error("Error fetching action queue:", error);
    res.status(500).json({ error: "Failed to fetch action queue" });
  }
}

function formatLead(lead) {
  return {
    contactId: lead.contactId,
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    marina: lead.marina,
    ownerName: lead.ownerName,
    createDate: lead.createDate,
    hubspotUrl: lead.hubspotUrl,
    recentFormDate: lead.recentFormDate || null,
    recentFormName: lead.recentFormName || null,
    numFormFills: lead.numFormFills || 0,
  };
}
