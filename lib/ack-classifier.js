const Anthropic = require("@anthropic-ai/sdk").default;
const crypto = require("crypto");
const {
  insertClassifierDecision,
  loadClassifierState,
  pruneClassifierDecisions,
  deleteAllClassifierDecisions,
} = require("./db");

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
    return { needsResponse: true, reason: "keyword", confidence: "high", label: "has_question", matchedPhrase: "?" };
  }
  for (const kw of QUESTION_KEYWORDS) {
    if (lower.includes(kw)) {
      return { needsResponse: true, reason: "keyword", confidence: "medium", label: "has_intent_keyword", matchedPhrase: kw };
    }
  }
  const stripped = lower.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  for (const phrase of ACK_PHRASES) {
    if (stripped === phrase) {
      return { needsResponse: false, reason: "keyword", confidence: "high", label: "exact_ack", matchedPhrase: phrase };
    }
  }
  for (const phrase of ACK_PHRASES) {
    if (stripped.startsWith(phrase + " ") || stripped.endsWith(" " + phrase) || stripped.includes(" " + phrase + " ")) {
      if (stripped.length <= phrase.length + 40) {
        return { needsResponse: false, reason: "keyword", confidence: "medium", label: "ack_phrase", matchedPhrase: phrase };
      }
    }
    if (stripped.startsWith(phrase)) {
      if (stripped.length <= phrase.length + 30) {
        return { needsResponse: false, reason: "keyword", confidence: "medium", label: "ack_phrase", matchedPhrase: phrase };
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

async function classifyWithAI(cleanText) {
  const anthropic = getAnthropicClient();
  if (!anthropic) {
    return { needsResponse: true, reason: "fallback", confidence: "low", label: "no_ai_key" };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  try {
    const response = await anthropic.messages.create(
      {
        model: "claude-haiku-4-5",
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
    const text = response.content[0].text.trim();
    const parsed = JSON.parse(extractJson(text));
    return {
      needsResponse: !!parsed.needsResponse,
      reason: "ai",
      confidence: "medium",
      label: parsed.label || (parsed.needsResponse ? "ai_needs_response" : "ai_acknowledgment"),
    };
  } catch (err) {
    console.warn("[ack-classifier] AI error:", err.message);
    return { needsResponse: true, reason: "fallback", confidence: "low", label: "ai_error" };
  } finally {
    clearTimeout(timer);
  }
}

const DEBUG = (process.env.AI_ACK_CLASSIFIER_DEBUG || "").toLowerCase() === "on";
function debugLog(engagementId, verdict, cacheHit) {
  if (!DEBUG) return;
  console.log(
    `[ack-classifier] eng=${engagementId || "n/a"} reason=${verdict.reason} ` +
    `needsResponse=${verdict.needsResponse} confidence=${verdict.confidence} ` +
    `label=${verdict.label} cache=${cacheHit ? "hit" : "miss"}`
  );
}

async function classifyInbound(engagement) {
  if (!engagement) {
    const out = { needsResponse: true, reason: "fallback", confidence: "low", label: "no_engagement" };
    recordMetric(out, "", null, "fallback");
    return out;
  }

  if (engagement.type === "CALL") {
    const out = { needsResponse: true, reason: "keyword", confidence: "high", label: "inbound_call" };
    recordMetric(out, "", engagement, "keyword");
    return out;
  }

  const engId = engagement.id || engagement.engagementId;
  const raw = engagement.body || engagement.bodyPreview || "";
  const clean = stripQuotedAndSignature(raw);
  const key = cacheKey(engId, clean);
  const cached = getCached(key);
  if (cached) {
    debugLog(engId, cached, true);
    recordMetric(cached, clean, engagement, "cache");
    return cached;
  }

  const heuristic = classifyHeuristic(clean);
  if (heuristic) {
    setCached(key, heuristic);
    debugLog(engId, heuristic, false);
    recordMetric(heuristic, clean, engagement, "keyword");
    return heuristic;
  }

  if (AI_DISABLED) {
    const out = { needsResponse: true, reason: "fallback", confidence: "low", label: "ai_disabled" };
    setCached(key, out);
    debugLog(engId, out, false);
    recordMetric(out, clean, engagement, "fallback");
    return out;
  }

  const aiResult = await classifyWithAI(clean);
  setCached(key, aiResult);
  debugLog(engId, aiResult, false);
  recordMetric(aiResult, clean, engagement, "ai");
  return aiResult;
}

function clearAckCache() {
  cache.clear();
}

const METRICS_RECENT_MAX = 50;
const PREVIEW_MAX = 140;
const RETENTION_DAYS = (() => {
  const raw = Number(process.env.CLASSIFIER_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 90;
})();
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const metrics = {
  total: 0,
  cacheHits: 0,
  invocations: { keyword: 0, ai: 0, fallback: 0 },
  byOutcome: { acknowledgment: 0, needs_response: 0 },
  ackPhraseCounts: Object.create(null),
  recent: [],
  startedAt: Date.now(),
  loaded: false,
};

const _pendingInserts = new Set();

function trackInsert(p) {
  _pendingInserts.add(p);
  p.finally(() => _pendingInserts.delete(p));
}

async function reloadClassifierMetricsFromDb() {
  // Wait for any in-flight inserts so the DB snapshot is complete.
  if (_pendingInserts.size > 0) {
    await Promise.allSettled(Array.from(_pendingInserts));
  }
  const state = await loadClassifierState({ recentLimit: METRICS_RECENT_MAX });
  if (!state) return;
  metrics.total = state.total;
  metrics.cacheHits = state.cacheHits;
  metrics.invocations = state.invocations;
  metrics.byOutcome = state.byOutcome;
  const counts = Object.create(null);
  for (const p of state.ackPhraseCounts) {
    const k = `${p.source}::${p.phrase}`;
    counts[k] = { phrase: p.phrase, source: p.source, count: p.count };
  }
  metrics.ackPhraseCounts = counts;
  metrics.recent = state.recent;
  if (state.startedAtMs) {
    metrics.startedAt = state.startedAtMs;
  }
}

let _initPromise = null;
function initClassifierMetrics() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    await pruneClassifierDecisions(RETENTION_DAYS).catch(() => {});
    await reloadClassifierMetricsFromDb();
    metrics.loaded = true;
  })().catch((err) => {
    console.error("[ack-classifier] init error:", err.message);
    metrics.loaded = true;
  });
  return _initPromise;
}

let _pruneTimer = null;
function startClassifierPruneScheduler() {
  if (_pruneTimer) return;
  _pruneTimer = setInterval(async () => {
    const removed = await pruneClassifierDecisions(RETENTION_DAYS).catch(() => 0);
    if (removed > 0 && metrics.loaded) {
      await reloadClassifierMetricsFromDb().catch((err) =>
        console.error("[ack-classifier] post-prune reload error:", err.message)
      );
    }
  }, PRUNE_INTERVAL_MS);
  if (_pruneTimer.unref) _pruneTimer.unref();
}

function recordMetric(verdict, cleanText, engagement, source) {
  try {
    metrics.total += 1;
    if (source === "cache") {
      metrics.cacheHits += 1;
    } else if (metrics.invocations[source] !== undefined) {
      metrics.invocations[source] += 1;
    } else {
      metrics.invocations.fallback += 1;
    }
    const outcomeKey = verdict.needsResponse ? "needs_response" : "acknowledgment";
    metrics.byOutcome[outcomeKey] += 1;
    if (!verdict.needsResponse) {
      const trigger = verdict.matchedPhrase
        ? { phrase: verdict.matchedPhrase, source: "keyword" }
        : verdict.reason === "ai" && verdict.label
          ? { phrase: verdict.label, source: "ai" }
          : null;
      if (trigger) {
        const k = `${trigger.source}::${trigger.phrase}`;
        if (!metrics.ackPhraseCounts[k]) {
          metrics.ackPhraseCounts[k] = { phrase: trigger.phrase, source: trigger.source, count: 0 };
        }
        metrics.ackPhraseCounts[k].count += 1;
      }
    }
    const preview = (cleanText || "").slice(0, PREVIEW_MAX);
    const entry = {
      at: Date.now(),
      engagementId: (engagement && (engagement.id || engagement.engagementId)) || null,
      type: (engagement && engagement.type) || null,
      source,
      reason: verdict.reason,
      confidence: verdict.confidence,
      label: verdict.label,
      matchedPhrase: verdict.matchedPhrase || null,
      needsResponse: !!verdict.needsResponse,
      preview,
    };
    metrics.recent.unshift(entry);
    if (metrics.recent.length > METRICS_RECENT_MAX) {
      metrics.recent.length = METRICS_RECENT_MAX;
    }
    if (metrics.total === 1 && metrics.startedAt > entry.at) {
      metrics.startedAt = entry.at;
    }
    trackInsert(insertClassifierDecision(entry).catch(() => {}));
  } catch (_) {
    // never let metrics break classification
  }
}

async function getClassifierMetrics() {
  if (!metrics.loaded) {
    await initClassifierMetrics();
  }
  const total = metrics.total;
  const invTotal = metrics.invocations.keyword + metrics.invocations.ai + metrics.invocations.fallback;
  const pct = (n, denom) => (denom > 0 ? Math.round((n / denom) * 1000) / 10 : 0);
  const topAckPhrases = Object.values(metrics.ackPhraseCounts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return {
    total,
    cacheHits: metrics.cacheHits,
    freshClassifications: invTotal,
    startedAt: metrics.startedAt,
    invocations: { ...metrics.invocations },
    pctByInvocation: {
      keyword: pct(metrics.invocations.keyword, invTotal),
      ai: pct(metrics.invocations.ai, invTotal),
      fallback: pct(metrics.invocations.fallback, invTotal),
    },
    byOutcome: { ...metrics.byOutcome },
    pctByOutcome: {
      acknowledgment: pct(metrics.byOutcome.acknowledgment, total),
      needs_response: pct(metrics.byOutcome.needs_response, total),
    },
    topAckPhrases,
    recent: metrics.recent.slice(0, METRICS_RECENT_MAX),
  };
}

async function resetClassifierMetrics() {
  metrics.total = 0;
  metrics.cacheHits = 0;
  metrics.invocations = { keyword: 0, ai: 0, fallback: 0 };
  metrics.byOutcome = { acknowledgment: 0, needs_response: 0 };
  metrics.ackPhraseCounts = Object.create(null);
  metrics.recent = [];
  metrics.startedAt = Date.now();
  metrics.loaded = true;
  await deleteAllClassifierDecisions();
}

module.exports = {
  classifyInbound,
  stripQuotedAndSignature,
  clearAckCache,
  getClassifierMetrics,
  resetClassifierMetrics,
  initClassifierMetrics,
  startClassifierPruneScheduler,
};
