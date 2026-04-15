import { getAllLeadsData } from "../../../lib/leads";
import { generateLeadSummary } from "../../../lib/sentiment";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { id } = req.query;

  try {
    const { leads } = await getAllLeadsData();
    const lead = leads.find((l) => l.contactId === id);

    if (!lead) {
      return res.status(404).json({ error: "Lead not found" });
    }

    const aiSummary = await generateLeadSummary(lead);
    res.status(200).json({ aiSummary });
  } catch (error) {
    console.error("Error generating lead summary:", error);
    res.status(500).json({ error: "Failed to generate summary" });
  }
}
