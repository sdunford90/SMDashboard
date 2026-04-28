import { getAllLeadsData, formatSpeedToLead, isSpeedToLeadEligible } from "../../lib/leads";

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

    function srcCounts(arr) {
      return {
        Call:    arr.filter((l) => l.leadSource === "Call").length,
        WalkIn:  arr.filter((l) => l.leadSource === "Walk-in").length,
        WebForm: arr.filter((l) => l.leadSource === "Web Form").length,
        Digital: arr.filter((l) => !["Call","Walk-in","Web Form"].includes(l.leadSource)).length,
      };
    }
    const srcAll     = srcCounts(leads);
    const src7Days   = srcCounts(leads7Days);
    const srcMonth   = srcCounts(leadsThisMonth);

    const marinas = [...new Set(leads.map((l) => l.marina))].sort();

    // Speed to lead by property (last 7 days)
    const speedByProperty = marinas
      .map((marina) => {
        const ml = leads7Days.filter((l) => l.marina === marina);
        const responded = ml.filter((l) => l.responded);
        // Only responded Web Form / Digital leads count toward the average
        // (see isSpeedToLeadEligible in lib/leads.js).
        const withBiz = ml.filter((l) => isSpeedToLeadEligible(l));
        const avg =
          withBiz.length > 0
            ? withBiz.reduce((s, l) => s + l.speedToLeadBizMinutes, 0) / withBiz.length
            : null;
        const respondedPct = ml.length > 0 ? Math.round((responded.length / ml.length) * 100) : null;
        return {
          marina,
          total: ml.length,
          respondedCount: responded.length,
          respondedPct,
          avgSpeedMinutes: avg !== null ? Math.round(avg) : null,
          avgSpeedFormatted: avg !== null ? formatSpeedToLead(avg) : "--",
        };
      })
      .filter((m) => m.total > 0 && m.marina !== "Unknown")
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
      .filter((m) => m.count > 0 && m.marina !== "Unknown")
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
      .filter((m) => m.total > 0 && m.marina !== "Unknown")
      .sort((a, b) => b.total - a.total);

    // Lead source breakdown (all-time, all marinas)
    const sourceCount = { Call: 0, "Walk-in": 0, "Web Form": 0, Digital: 0 };
    const sourceByMarina = {};
    for (const lead of leads) {
      const raw = lead.leadSource || "Digital";
      const bucket = raw === "Call" ? "Call" : raw === "Walk-in" ? "Walk-in" : raw === "Web Form" ? "Web Form" : "Digital";
      sourceCount[bucket] = (sourceCount[bucket] || 0) + 1;
      if (!sourceByMarina[lead.marina]) sourceByMarina[lead.marina] = { Call: 0, "Walk-in": 0, "Web Form": 0, Digital: 0 };
      sourceByMarina[lead.marina][bucket] = (sourceByMarina[lead.marina][bucket] || 0) + 1;
    }
    const leadSourceByMarina = Object.entries(sourceByMarina)
      .map(([marina, counts]) => ({
        marina,
        Call: counts.Call || 0,
        "Walk-in": counts["Walk-in"] || 0,
        "Web Form": counts["Web Form"] || 0,
        Digital: counts.Digital || 0,
        total: (counts.Call || 0) + (counts["Walk-in"] || 0) + (counts["Web Form"] || 0) + (counts.Digital || 0),
      }))
      .filter((m) => m.total > 0 && m.marina !== "Unknown")
      .sort((a, b) => b.total - a.total);

    // Conversions — return raw list so client can re-slice by period.
    const convertedLeads = leads
      .filter((l) => l.isCustomer)
      .map((l) => ({
        marina: l.marina,
        daysToConvert: l.daysToConvert ?? null,
        convertedAt: l.convertedAt ?? null,
      }));

    res.status(200).json({
      newLeads7Days,
      monthlyLeads,
      totalLeads,
      src7Days,
      srcMonth,
      srcAll,
      speedByProperty,
      newLeadsByProperty,
      callsByLocation,
      convertedLeads,
      sourceCount,
      leadSourceByMarina,
      generatedAt: now.toISOString(),
    });
  } catch (err) {
    console.error("Presentation API error:", err);
    res.status(500).json({ error: "Failed to load presentation data" });
  }
}
