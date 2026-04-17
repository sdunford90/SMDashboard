const Anthropic = require("@anthropic-ai/sdk").default;
const crypto = require("crypto");

let _client = null;
function getAnthropicClient() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const AI_DISABLED = (process.env.AI_ACK_CLASSIFIER || "").toLowerCase() === "off";
const AI_TIMEOUT_MS = 5000;

const MAX_ACK_LENGTH = 160;

const ACK_PHRASES = [
  "thanks", "thank you", "thanks so much", "thanks!", "thank you!",
  "thx", "ty", "tysm", "many thanks", "thanks again", "thank you again",
  "thanks for the info", "thanks for the information", "thanks for your help",
  "thanks for your time", "appreciate it", "appreciated", "much appreciated",
  "got it", "received", "noted", "understood", "ok", "okay", "k",
  "perfect", "great", "awesome", "sounds good", "works for me",
  "no problem", "no worries", "all good", "you're the best",
  "will do", "talk soon", "speak soon", "see you", "see ya", "cheers",
  "have a good one", "have a great day", "you too", "same to you",
];

const QUESTION_KEYWORDS = [
  "price", "pricing", "cost", "rate", "rates", "fee", "fees", "deposit",
  "available", "availability", "open", "vacancy", "vacant",
  "when", "what time", "how much", "how long", "how do",
  "schedule", "appointment", "tour", "visit", "showing",
  "slip", "dock", "boat", "vessel", "length", "beam", "draft",
  "contract", "lease", "agreement", "sign",
  "call me", "email me", "text me", "reach me",
  "reservation", "book", "booking", "reserve",
  "question", "wondering", "curious",
  "could you", "can you", "would you", "will you",
  "?",
];

function stripQuotedAndSignature(text) {
  if (!text) return "";
  let s = String(text).replace(/\r\n/g, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  const lines = s.split("\n");
  const kept = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith(">")) break;
    if (/^on .+ (wrote|sent):?\s*$/i.test(line)) break;
    if (/^-{2,}\s*original message\s*-{2,}/i.test(line)) break;
    if (/^from:\s/i.test(line) && kept.length > 0) break;
    if (/^sent from my /i.test(line)) continue;
    if (/^get outlook for /i.test(line)) continue;
    if (/^-- ?$/.test(line)) break;
    kept.push(line);
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

function classifyHeuristic(cleanText) {
  const lower = cleanText.toLowerCase();
  if (lower.length === 0) {
    // Empty cleaned text (e.g. attachment-only or content stripped by quoting/signature
    // removal) is ambiguous — be conservative and treat as needing a response.
    return { needsResponse: true, reason: "keyword", confidence: "low", label: "empty_or_unparsed" };
  }
  if (lower.length > MAX_ACK_LENGTH) {
    return null;
  }
  if (lower.includes("?")) {
    return { needsResponse: true, reason: "keyword", confidence: "high", label: "has_question" };
  }
  for (const kw of QUESTION_KEYWORDS) {
    if (lower.includes(kw)) {
      return { needsResponse: true, reason: "keyword", confidence: "medium", label: "has_intent_keyword" };
    }
  }
  const stripped = lower.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  for (const phrase of ACK_PHRASES) {
    if (stripped === phrase) {
      return { needsResponse: false, reason: "keyword", confidence: "high", label: "exact_ack" };
    }
  }
  for (const phrase of ACK_PHRASES) {
    if (stripped.startsWith(phrase + " ") || stripped.endsWith(" " + phrase) || stripped.includes(" " + phrase + " ")) {
      if (stripped.length <= phrase.length + 40) {
        return { needsResponse: false, reason: "keyword", confidence: "medium", label: "ack_phrase" };
      }
    }
    if (stripped.startsWith(phrase)) {
      if (stripped.length <= phrase.length + 30) {
        return { needsResponse: false, reason: "keyword", confidence: "medium", label: "ack_phrase" };
      }
    }
  }
  return null;
}

const cache = new Map();
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX = 5000;

function cacheKey(engagementId, cleanText) {
  const hash = crypto.createHash("sha1").update(cleanText).digest("hex").slice(0, 12);
  return `${engagementId || "no-id"}::${hash}`;
}

function getCached(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.t > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return e.v;
}

function setCached(key, value) {
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { v: value, t: Date.now() });
}

async function classifyWithAI(cleanText) {
  const anthropic = getAnthropicClient();
  if (!anthropic) {
    return { needsResponse: true, reason: "fallback", confidence: "low", label: "no_ai_key" };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
    const response = await anthropic.messages.create(
      {
        model: "claude-3-haiku-20240307",
        max_tokens: 60,
        messages: [
          {
            role: "user",
            content: `You classify short customer reply emails to a marina sales rep.

Decide whether the rep needs to write back, or whether the customer is just acknowledging / closing the thread.

Respond with ONLY valid JSON (no markdown), no extra text:
{"needsResponse": true|false, "label": "short_label_under_3_words"}

Customer message:
"""
${cleanText.slice(0, 1200)}
"""`,
          },
        ],
      },
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    const text = response.content[0].text.trim();
    const parsed = JSON.parse(text);
    return {
      needsResponse: !!parsed.needsResponse,
      reason: "ai",
      confidence: "medium",
      label: parsed.label || (parsed.needsResponse ? "ai_needs_response" : "ai_acknowledgment"),
    };
  } catch (err) {
    console.warn("[ack-classifier] AI error:", err.message);
    return { needsResponse: true, reason: "fallback", confidence: "low", label: "ai_error" };
  }
}

async function classifyInbound(engagement) {
  if (!engagement) {
    return { needsResponse: true, reason: "fallback", confidence: "low", label: "no_engagement" };
  }

  if (engagement.type === "CALL") {
    return { needsResponse: true, reason: "keyword", confidence: "high", label: "inbound_call" };
  }

  const raw = engagement.body || engagement.bodyPreview || "";
  const clean = stripQuotedAndSignature(raw);
  const key = cacheKey(engagement.id || engagement.engagementId, clean);
  const cached = getCached(key);
  if (cached) return cached;

  const heuristic = classifyHeuristic(clean);
  if (heuristic) {
    setCached(key, heuristic);
    return heuristic;
  }

  if (AI_DISABLED) {
    const out = { needsResponse: true, reason: "fallback", confidence: "low", label: "ai_disabled" };
    setCached(key, out);
    return out;
  }

  const aiResult = await classifyWithAI(clean);
  setCached(key, aiResult);
  return aiResult;
}

function clearAckCache() {
  cache.clear();
}

module.exports = {
  classifyInbound,
  stripQuotedAndSignature,
  clearAckCache,
};
