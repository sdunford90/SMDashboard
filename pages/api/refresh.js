import { clearCache, forceRefresh } from "../../lib/leads";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  clearCache();
  forceRefresh()
    .then(() => console.log("[api/refresh] Manual refresh complete."))
    .catch((err) => console.error("[api/refresh] Manual refresh failed:", err.message));

  res.status(200).json({ success: true, message: "Refresh started" });
}
