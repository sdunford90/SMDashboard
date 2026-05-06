import { getAllLeadsData } from "../../lib/leads";

// Map a lead's classified source (using hsSource where available, falling
// back to leadSource) to the coarse acquisition-channel buckets we want to
// report on the hidden /sources page.
function bucketSource(lead) {
  const hs = (lead.hsSource || "").trim();
  const ls = (lead.leadSource || "").trim();

  // Rep-entered sources (CRM_UI) come through hsSource as the raw
  // lead_source label, e.g. "Phone Call", "Walk-In", "Referral".
  const hsLower = hs.toLowerCase();
  if (hsLower.includes("walk")) return "Walk-in";
  if (hsLower.includes("phone") || hsLower === "call") return "Call";

  if (hs === "Social Media" || hs === "Social (Form)") return "Social Media";
  if (hs === "Referral" || hs === "Referral (Form)" || hsLower.includes("referral")) return "Referral";
  if (hs === "Paid Search" || hs === "Paid Search (Form)") return "Google PPC";
  if (hs === "Organic Search" || hs === "Organic Search (Form)") return "Organic Search";
  if (hs === "Direct Traffic" || hs === "Direct (Form)") return "Direct";
  if (hs === "Email") return "Email";
  if (hs === "Web Form") return "Web Form";

  if (ls === "Walk-in") return "Walk-in";
  if (ls === "Call") return "Call";
  if (ls === "Web Form") return "Web Form";
  if (ls === "Digital") return "Other";

  return "Other";
}

const WINDOW_START = new Date("2026-01-01T00:00:00.000Z");

export default async function handler(req, res) {
  try {
    const { leads } = await getAllLeadsData();

    const eligible = leads.filter(
      (l) =>
        !l.isSpam &&
        l.createDate &&
        new Date(l.createDate) >= WINDOW_START &&
        l.marina &&
        l.marina !== "Unknown"
    );

    // (property, source) -> { total, converted }
    const cellMap = new Map();
    const sourceMap = new Map();
    const propertyMap = new Map();

    for (const lead of eligible) {
      const property = lead.marina;
      const source = bucketSource(lead);
      const key = `${property}\u0000${source}`;

      if (!cellMap.has(key)) cellMap.set(key, { property, source, total: 0, converted: 0 });
      if (!sourceMap.has(source)) sourceMap.set(source, { source, total: 0, converted: 0 });
      if (!propertyMap.has(property)) propertyMap.set(property, { property, total: 0, converted: 0 });

      const cell = cellMap.get(key);
      const src = sourceMap.get(source);
      const prop = propertyMap.get(property);

      cell.total++;
      src.total++;
      prop.total++;
      if (lead.isCustomer) {
        cell.converted++;
        src.converted++;
        prop.converted++;
      }
    }

    const withRatio = (row) => ({
      ...row,
      closeRatio: row.total > 0 ? row.converted / row.total : 0,
    });

    const rows = Array.from(cellMap.values())
      .map(withRatio)
      .sort((a, b) => {
        if (a.property !== b.property) return a.property.localeCompare(b.property);
        return b.total - a.total;
      });

    const bySource = Array.from(sourceMap.values())
      .map(withRatio)
      .sort((a, b) => b.total - a.total);

    const byProperty = Array.from(propertyMap.values())
      .map(withRatio)
      .sort((a, b) => b.total - a.total);

    const totalLeads = eligible.length;
    const totalConverted = eligible.filter((l) => l.isCustomer).length;

    res.status(200).json({
      windowStart: WINDOW_START.toISOString(),
      totals: {
        leads: totalLeads,
        converted: totalConverted,
        closeRatio: totalLeads > 0 ? totalConverted / totalLeads : 0,
      },
      rows,
      bySource,
      byProperty,
    });
  } catch (err) {
    console.error("Sources API error:", err);
    res.status(500).json({ error: "Failed to load source breakdown" });
  }
}
