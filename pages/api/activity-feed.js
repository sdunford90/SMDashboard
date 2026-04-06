import { getAllLeadsData, getEmailSubtype } from "../../lib/leads";

export default async function handler(req, res) {
  try {
    const { leads } = await getAllLeadsData();
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const activities = [];

    for (const lead of leads) {
      for (const eng of lead.engagements) {
        const engDate = new Date(eng.timestamp);
        if (engDate < sevenDaysAgo) continue;

        let subtype, summary;
        if (eng.type === "EMAIL") {
          subtype = getEmailSubtype(eng);
          const dirLabel =
            subtype === "EMAIL_INBOUND"
              ? "Received email from"
              : subtype === "EMAIL_LOGGED"
              ? "Logged email to"
              : "Sent email to";
          summary = `${dirLabel} ${lead.name}${eng.subject ? " -- " + eng.subject : ""}`;
        } else {
          subtype =
            eng.direction === "INBOUND" ? "INBOUND_CALL" : "OUTBOUND_CALL";
          const callDir = eng.direction === "INBOUND" ? "Received call from" : "Called";
          summary = `${callDir} ${lead.name} -- ${eng.disposition || "Unknown"}`;
        }

        activities.push({
          timestamp: eng.timestamp,
          type: eng.type,
          subtype,
          disposition: eng.disposition || null,
          repName: lead.ownerName,
          leadName: lead.name,
          marina: lead.marina,
          summary,
          duration:
            eng.type === "CALL" && eng.durationMilliseconds
              ? formatDuration(eng.durationMilliseconds)
              : null,
          hubspotUrl: lead.hubspotUrl,
        });
      }
    }

    // Sort reverse chronological
    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.status(200).json({ activities: activities.slice(0, 50) });
  } catch (error) {
    console.error("Error fetching activity feed:", error);
    res.status(500).json({ error: "Failed to fetch activity feed" });
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
