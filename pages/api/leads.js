import { getAllLeadsData, formatSpeedToLead } from "../../lib/leads";

export default async function handler(req, res) {
  try {
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
      lastTouch: lead.lastTouch,
      hubspotUrl: lead.hubspotUrl,
      analyticsSource: lead.analyticsSource,
      analyticsSourceData1: lead.analyticsSourceData1,
      isPowerAutomate: lead.isPowerAutomate,
      status: lead.hasMissedInbound
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
