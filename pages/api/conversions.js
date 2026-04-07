import { getAllLeadsData } from "../../lib/leads";

export default async function handler(req, res) {
  try {
    const { leads } = await getAllLeadsData();

    const converted = leads
      .filter((l) => l.isCustomer)
      .sort((a, b) => {
        if (!a.convertedAt && !b.convertedAt) return 0;
        if (!a.convertedAt) return 1;
        if (!b.convertedAt) return -1;
        return new Date(b.convertedAt) - new Date(a.convertedAt);
      });

    const withDays = converted.filter((l) => l.daysToConvert !== null);
    const avgDays =
      withDays.length > 0
        ? Math.round(
            withDays.reduce((s, l) => s + l.daysToConvert, 0) / withDays.length
          )
        : null;
    const fastest =
      withDays.length > 0
        ? Math.min(...withDays.map((l) => l.daysToConvert))
        : null;

    const marinaMap = {};
    for (const lead of converted) {
      if (!marinaMap[lead.marina]) {
        marinaMap[lead.marina] = { count: 0, totalDays: 0, withDays: 0 };
      }
      marinaMap[lead.marina].count++;
      if (lead.daysToConvert !== null) {
        marinaMap[lead.marina].totalDays += lead.daysToConvert;
        marinaMap[lead.marina].withDays++;
      }
    }
    const byMarina = Object.entries(marinaMap)
      .map(([marina, stats]) => ({
        marina,
        count: stats.count,
        avgDays:
          stats.withDays > 0
            ? Math.round(stats.totalDays / stats.withDays)
            : null,
      }))
      .sort((a, b) => b.count - a.count);

    res.status(200).json({
      total: converted.length,
      avgDays,
      fastest,
      byMarina,
      leads: converted.map((l) => ({
        contactId: l.contactId,
        name: l.name,
        marina: l.marina,
        createDate: l.createDate,
        convertedAt: l.convertedAt,
        daysToConvert: l.daysToConvert,
        hubspotUrl: l.hubspotUrl,
      })),
    });
  } catch (err) {
    console.error("Conversions API error:", err);
    res.status(500).json({ error: "Failed to load conversion data" });
  }
}
