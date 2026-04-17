import { getClassifierMetrics } from "../../lib/ack-classifier";

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export default function handler(req, res) {
  try {
    const m = getClassifierMetrics();
    if ((req.query.format || "").toLowerCase() === "csv") {
      const header = ["timestamp", "engagementId", "type", "source", "reason", "confidence", "label", "matchedPhrase", "needsResponse", "preview"];
      const lines = [header.join(",")];
      for (const r of m.recent) {
        lines.push([
          new Date(r.at).toISOString(),
          r.engagementId,
          r.type,
          r.source,
          r.reason,
          r.confidence,
          r.label,
          r.matchedPhrase,
          r.needsResponse,
          r.preview,
        ].map(csvEscape).join(","));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="classifier-decisions-${Date.now()}.csv"`);
      res.status(200).send(lines.join("\n"));
      return;
    }
    res.status(200).json(m);
  } catch (err) {
    console.error("[classifier-metrics] Error:", err.message);
    res.status(500).json({ error: "Failed to get classifier metrics" });
  }
}
