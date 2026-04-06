import { getAllLeadsData } from "../../lib/leads";

export default async function handler(req, res) {
  try {
    const { leads } = await getAllLeadsData();
    const { days = 30 } = req.query;
    const daysNum = parseInt(days, 10) || 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysNum);

    const marinas = [...new Set(leads.map((l) => l.marina))].sort();
    const marinaStats = {};

    for (const marina of marinas) {
      const marinaLeads = leads.filter((l) => l.marina === marina);
      let totalInbound = 0;
      let totalOutbound = 0;
      let connectedOutbound = 0;
      let totalConnectedDuration = 0;
      let connectedCount = 0;
      const recentCalls = [];

      for (const lead of marinaLeads) {
        for (const eng of lead.engagements) {
          if (eng.type !== "CALL") continue;
          const engDate = new Date(eng.timestamp);
          if (engDate < cutoff) continue;

          if (eng.direction === "INBOUND") totalInbound++;
          if (eng.direction === "OUTBOUND") {
            totalOutbound++;
            if (eng.disposition === "Connected") connectedOutbound++;
          }
          if (eng.disposition === "Connected") {
            totalConnectedDuration += eng.durationMilliseconds || 0;
            connectedCount++;
          }

          recentCalls.push({
            repName: lead.ownerName,
            leadName: lead.name,
            direction: eng.direction,
            disposition: eng.disposition,
            duration: eng.durationMilliseconds
              ? formatDuration(eng.durationMilliseconds)
              : null,
            durationMs: eng.durationMilliseconds || 0,
            notes: eng.body || "",
            timestamp: eng.timestamp,
            hubspotUrl: lead.hubspotUrl,
          });
        }
      }

      recentCalls.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      marinaStats[marina] = {
        marina,
        totalInbound,
        totalOutbound,
        connectedRate:
          totalOutbound > 0
            ? Math.round((connectedOutbound / totalOutbound) * 100)
            : 0,
        avgDurationSeconds:
          connectedCount > 0
            ? Math.round(totalConnectedDuration / connectedCount / 1000)
            : 0,
        avgDurationFormatted:
          connectedCount > 0
            ? formatDuration(totalConnectedDuration / connectedCount)
            : "0s",
        recentCalls: recentCalls.slice(0, 20),
      };
    }

    // Chart data for grouped bar chart
    const chartData = marinas.map((marina) => ({
      marina,
      inbound: marinaStats[marina].totalInbound,
      outbound: marinaStats[marina].totalOutbound,
    }));

    res.status(200).json({ marinaStats, chartData, marinas });
  } catch (error) {
    console.error("Error fetching calls:", error);
    res.status(500).json({ error: "Failed to fetch call data" });
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
