import { forceRefresh } from "../../lib/leads";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // forceRefresh() clears only the in-memory cache entry — DB cache stays
  // intact so concurrent dashboard API calls keep getting served stale data
  // rather than blocking for 4+ minutes while the HubSpot fetch runs.
  forceRefresh()
    .then(() => console.log("[api/refresh] Manual refresh complete."))
    .catch((err) => console.error("[api/refresh] Manual refresh failed:", err.message));

  res.status(200).json({ success: true, message: "Refresh started" });
}
