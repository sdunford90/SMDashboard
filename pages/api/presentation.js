import { getAllLeadsData, formatSpeedToLead } from "../../lib/leads";

export default async function handler(req, res) {
  try {
    const { leads } = await getAllLeadsData();
    const now = new Date();

    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const leads7Days = leads.filter((l) => new Date(l.createDate) >= sevenDaysAgo);
    const leadsThisMonth = leads.filter((l) => new Date(l.createDate) >= monthStart);

    const newLeads7Days = leads7Days.length;
    const monthlyLeads = leadsThisMonth.length;
    const totalLeads = leads.length;

    const marinas = [...new Set(leads.map((l) => l.marina))].sort();

    // Speed to lead by property (last 7 days)
    const speedByProperty = marinas
      .map((marina) => {
        const ml = leads7Days.filter((l) => l.marina === marina);
        const responded = ml.filter((l) => l.speedToLeadMinutes !== null);
        const avg =
          responded.length > 0
            ? responded.reduce((s, l) => s + l.speedToLeadMinutes, 0) / responded.length
            : null;
        return {
          marina,
          total: ml.length,
          respondedCount: responded.length,
          avgSpeedMinutes: avg !== null ? Math.round(avg) : null,
          avgSpeedFormatted: avg !== null ? formatSpeedToLead(avg) : "--",
        };
      })
      .filter((m) => m.total > 0)
      .sort((a, b) => {
        if (a.avgSpeedMinutes === null) return 1;
        if (b.avgSpeedMinutes === null) return -1;
        return a.avgSpeedMinutes - b.avgSpeedMinutes;
      });

    // New leads by property (last 7 days)
    const newLeadsByProperty = marinas
      .map((marina) => ({
        marina,
        count: leads7Days.filter((l) => l.marina === marina).length,
      }))
      .filter((m) => m.count > 0)
      .sort((a, b) => b.count - a.count);

    // Calls by location (last 7 days)
    const callsByLocation = marinas
      .map((marina) => {
        const ml = leads.filter((l) => l.marina === marina);
        let inbound = 0;
        let outbound = 0;
        for (const lead of ml) {
          for (const eng of lead.engagements) {
            if (eng.type !== "CALL") continue;
            if (new Date(eng.timestamp) < sevenDaysAgo) continue;
            if (eng.direction === "INBOUND") inbound++;
            else if (eng.direction === "OUTBOUND") outbound++;
          }
        }
        return { marina, inbound, outbound, total: inbound + outbound };
      })
      .filter((m) => m.total > 0)
      .sort((a, b) => b.total - a.total);

    res.status(200).json({
      newLeads7Days,
      monthlyLeads,
      totalLeads,
      speedByProperty,
      newLeadsByProperty,
      callsByLocation,
      generatedAt: now.toISOString(),
    });
  } catch (err) {
    console.error("Presentation API error:", err);
    res.status(500).json({ error: "Failed to load presentation data" });
  }
}
