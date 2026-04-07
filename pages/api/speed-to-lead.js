import { getAllLeadsData } from "../../lib/leads";

export default async function handler(req, res) {
  try {
    const { leads } = await getAllLeadsData();

    // Per-marina average speed to lead (business hours)
    const marinaMap = {};
    for (const lead of leads) {
      if (!lead.marina || lead.marina === "Unknown") continue;
      if (!marinaMap[lead.marina]) marinaMap[lead.marina] = { sum: 0, count: 0 };
      if (lead.speedToLeadBizMinutes !== null && lead.speedToLeadBizMinutes !== undefined) {
        marinaMap[lead.marina].sum += lead.speedToLeadBizMinutes;
        marinaMap[lead.marina].count += 1;
      }
    }

    const marinaSummary = Object.entries(marinaMap)
      .map(([marina, { sum, count }]) => ({
        marina,
        avgBizMinutes: count > 0 ? Math.round(sum / count) : null,
        respondedCount: count,
      }))
      .filter((r) => r.avgBizMinutes !== null)
      .sort((a, b) => a.avgBizMinutes - b.avgBizMinutes);

    res.status(200).json({ marinaSummary });
  } catch (error) {
    console.error("Error fetching speed to lead:", error);
    res.status(500).json({ error: "Failed to fetch speed to lead data" });
  }
}
