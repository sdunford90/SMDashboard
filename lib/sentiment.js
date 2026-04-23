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

  // Build engagement context for Claude.
  // Exclude any email sent from a @southernmarinas.com address — the AI
  // analysis is meant to read the lead's words, not internal/rep traffic.
  const INTERNAL_EMAIL_DOMAIN = "@southernmarinas.com";
  const filteredEngagements = lead.engagements.filter((eng) => {
    if (eng.type !== "EMAIL") return true;
    const sender = (eng.sentBy || "").toLowerCase();
    return !sender.endsWith(INTERNAL_EMAIL_DOMAIN);
  });

  const engagementText = filteredEngagements
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
      if (eng.type === "MEETING") {
        const start = eng.startTime ? new Date(eng.startTime).toLocaleString() : "N/A";
        return `[${date}] MEETING | Title: ${eng.title || "N/A"} | Scheduled: ${start} | Outcome: ${eng.outcome || "N/A"} | Notes: ${eng.body || "N/A"}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");

  function extractJson(text) {
    if (!text) return text;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return text.slice(start, end + 1);
    }
    return text;
  }

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
      model: "claude-haiku-4-5",
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
    const result = JSON.parse(extractJson(text));
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
