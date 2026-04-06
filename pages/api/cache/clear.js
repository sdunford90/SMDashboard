import { clearCache } from "../../../lib/leads";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  clearCache();
  res.status(200).json({ success: true, message: "Cache cleared" });
}
