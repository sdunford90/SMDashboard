import { manualRecheckLead } from "../../../lib/leads";

// Per-lead manual engagement recheck (Task #25). POST-only; the row's
// refresh button on the Never-Responded / All-Unresponded tabs hits
// this endpoint to re-fetch a single contact's engagements directly
// from HubSpot, persist them, patch the JSONB engagements field, and
// refresh the in-memory cache.
//
// Returns: { contactId, found, responded?, leadInDb }
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: "Missing contact id" });
  }
  try {
    const result = await manualRecheckLead(String(id));
    if (!result.leadInDb) {
      return res
        .status(404)
        .json({ error: "Lead not found in DB", ...result });
    }
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error(`[api/lead-recheck] error for ${id}:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
