const Anthropic = require("@anthropic-ai/sdk").default;

let client = null;

function getAnthropicClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      return null;
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

// Cache AI summaries for 30 minutes to avoid re-running
const summaryCache = new Map();
const SUMMARY_TTL = 30 * 60 * 1000;

function getCachedSummary(contactId) {
  const entry = summaryCache.get(contactId);
  if (entry && Date.now() - entry.timestamp < SUMMARY_TTL) {
    return entry.data;
  }
  summaryCache.delete(contactId);
  return null;
}

async function generateLeadSummary(lead) {
  const cached = getCachedSummary(lead.contactId);
  if (cached) return cached;

  const anthropic = getAnthropicClient();
  if (!anthropic) {
    return {
      summary: "AI summary unavailable (ANTHROPIC_API_KEY not set)",
      sentiment: "unknown",
      keyTopics: [],
      urgency: "unknown",
    };
  }

  // Build engagement context for Claude
  const engagementText = lead.engagements
    .slice(-20) // last 20 engagements max
    .map((eng) => {
      const date = new Date(eng.timestamp).toLocaleDateString();
      if (eng.type === "EMAIL") {
        const dir = eng.direction === "INCOMING" || eng.direction === "INBOUND" ? "INBOUND" : "OUTBOUND";
        const logged = eng.loggedFrom === "CRM" ? " (manually logged)" : "";
        return `[${date}] EMAIL ${dir}${logged} | Subject: ${eng.subject || "N/A"} | Preview: ${eng.bodyPreview || "N/A"}`;
      }
      if (eng.type === "CALL") {
        return `[${date}] CALL ${eng.direction} | Disposition: ${eng.disposition} | Duration: ${eng.durationMilliseconds ? Math.round(eng.durationMilliseconds / 1000) + "s" : "N/A"} | Notes: ${eng.body || "N/A"}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");

  if (!engagementText) {
    const result = {
      summary: "No engagement activity to analyze.",
      sentiment: "neutral",
      keyTopics: [],
      urgency: "low",
    };
    summaryCache.set(lead.contactId, { data: result, timestamp: Date.now() });
    return result;
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: `Analyze this marina lead's engagement history and provide a brief JSON response.

Lead: ${lead.name} | Marina: ${lead.marina} | Rep: ${lead.ownerName}
Created: ${new Date(lead.createDate).toLocaleDateString()}

Engagement Timeline:
${engagementText}

Respond with ONLY valid JSON (no markdown):
{
  "summary": "2-3 sentence summary of the conversation and where things stand",
  "sentiment": "positive" | "neutral" | "negative" | "frustrated",
  "keyTopics": ["topic1", "topic2"],
  "urgency": "high" | "medium" | "low",
  "nextStep": "recommended next action for the rep"
}`,
        },
      ],
    });

    const text = response.content[0].text.trim();
    const result = JSON.parse(text);
    summaryCache.set(lead.contactId, { data: result, timestamp: Date.now() });
    return result;
  } catch (err) {
    console.error("AI summary error:", err.message);
    return {
      summary: "Unable to generate AI summary at this time.",
      sentiment: "unknown",
      keyTopics: [],
      urgency: "unknown",
    };
  }
}

function clearSummaryCache() {
  summaryCache.clear();
}

module.exports = { generateLeadSummary, clearSummaryCache };
