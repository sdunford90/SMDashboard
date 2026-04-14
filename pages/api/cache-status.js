import { getCacheStatus } from "../../lib/leads";

export default async function handler(req, res) {
  try {
    const status = await getCacheStatus();
    res.status(200).json(status);
  } catch (err) {
    console.error("[cache-status] Error:", err.message);
    res.status(500).json({ error: "Failed to get cache status" });
  }
}
