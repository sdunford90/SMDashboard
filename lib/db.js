const { Pool } = require("pg");

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Fail fast if we can't get a connection so requests don't hang.
      connectionTimeoutMillis: 5000,
      // Recycle idle connections so they don't get silently killed by
      // the network/Postgres after long idle periods.
      idleTimeoutMillis: 30_000,
      // Cap how long any single statement can run server-side.
      statement_timeout: 10_000,
      // TCP keepalive prevents silent half-open connections that would
      // otherwise hang forever on the next query.
      keepAlive: true,
    });
    pool.on("error", (err) => {
      // Log and let pg discard the bad client; the pool will create a
      // fresh one on the next request.
      console.error("[db-pool] idle client error:", err.message);
    });
  }
  return pool;
}

// Wrap a pg query with a hard JS-side timeout so even a wedged TCP
// connection can't hang the request. Falls back to throwing on timeout
// so callers' try/catch returns null and we serve from in-memory cache
// or trigger a refresh instead of spinning forever.
async function queryWithTimeout(text, params, timeoutMs = 8000) {
  const client = await getPool().connect();
  try {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`db query timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([client.query(text, params), timeout]);
      return result;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    // release(true) discards the client if the timeout fired so a
    // half-broken connection isn't reused for the next request.
    client.release();
  }
}

const DB_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

async function getDbCache(key) {
  try {
    const result = await queryWithTimeout(
      "SELECT data FROM hubspot_cache WHERE key = $1 AND expires_at > NOW()",
      [key]
    );
    if (result.rows.length > 0) {
      return result.rows[0].data;
    }
  } catch (err) {
    console.error("[db-cache] read error:", err.message);
  }
  return null;
}

// Returns data even if expired, plus an `isStale` flag
async function getDbCacheWithStale(key) {
  try {
    const result = await queryWithTimeout(
      "SELECT data, expires_at > NOW() AS fresh FROM hubspot_cache WHERE key = $1",
      [key]
    );
    if (result.rows.length > 0) {
      return { data: result.rows[0].data, isStale: !result.rows[0].fresh };
    }
  } catch (err) {
    console.error("[db-cache] read error:", err.message);
  }
  return null;
}

async function setDbCache(key, data, ttlMs = DB_CACHE_TTL_MS) {
  try {
    await getPool().query(
      `INSERT INTO hubspot_cache (key, data, cached_at, expires_at)
       VALUES ($1, $2, NOW(), NOW() + ($3 || ' milliseconds')::INTERVAL)
       ON CONFLICT (key) DO UPDATE
         SET data = EXCLUDED.data,
             cached_at = NOW(),
             expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(data), ttlMs]
    );
  } catch (err) {
    console.error("[db-cache] write error:", err.message);
  }
}

async function clearDbCache() {
  try {
    await getPool().query("DELETE FROM hubspot_cache");
  } catch (err) {
    console.error("[db-cache] clear error:", err.message);
  }
}

async function getDbCacheMeta(key) {
  try {
    const result = await getPool().query(
      "SELECT cached_at, expires_at FROM hubspot_cache WHERE key = $1",
      [key]
    );
    if (result.rows.length > 0) {
      return {
        cachedAt: result.rows[0].cached_at,
        expiresAt: result.rows[0].expires_at,
      };
    }
  } catch (err) {
    console.error("[db-cache] meta read error:", err.message);
  }
  return null;
}

let _classifierTableReady = null;

async function ensureClassifierTable() {
  if (_classifierTableReady) return _classifierTableReady;
  _classifierTableReady = (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS classifier_decisions (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        engagement_id TEXT,
        engagement_type TEXT,
        source TEXT,
        reason TEXT,
        confidence TEXT,
        label TEXT,
        matched_phrase TEXT,
        needs_response BOOLEAN,
        preview TEXT
      );
    `);
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS idx_classifier_decisions_at ON classifier_decisions (at DESC);`
    );
  })().catch((err) => {
    console.error("[classifier-store] ensure table error:", err.message);
    _classifierTableReady = null;
    throw err;
  });
  return _classifierTableReady;
}

async function insertClassifierDecision(rec) {
  try {
    await ensureClassifierTable();
    await getPool().query(
      `INSERT INTO classifier_decisions
        (at, engagement_id, engagement_type, source, reason, confidence, label, matched_phrase, needs_response, preview)
       VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        rec.at,
        rec.engagementId,
        rec.type,
        rec.source,
        rec.reason,
        rec.confidence,
        rec.label,
        rec.matchedPhrase,
        rec.needsResponse,
        rec.preview,
      ]
    );
  } catch (err) {
    console.error("[classifier-store] insert error:", err.message);
  }
}

async function loadClassifierState({ recentLimit = 50 } = {}) {
  try {
    await ensureClassifierTable();
    const pool = getPool();
    const totalsP = pool.query(`
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE source = 'cache')::bigint AS cache_hits,
        COUNT(*) FILTER (WHERE source = 'keyword')::bigint AS inv_keyword,
        COUNT(*) FILTER (WHERE source = 'ai')::bigint AS inv_ai,
        COUNT(*) FILTER (WHERE source = 'fallback')::bigint AS inv_fallback,
        COUNT(*) FILTER (WHERE needs_response = false)::bigint AS acknowledgment,
        COUNT(*) FILTER (WHERE needs_response = true)::bigint AS needs_response,
        EXTRACT(EPOCH FROM MIN(at)) * 1000 AS started_at_ms
      FROM classifier_decisions
    `);
    const phrasesP = pool.query(`
      SELECT
        CASE WHEN matched_phrase IS NOT NULL THEN 'keyword'
             WHEN reason = 'ai' AND label IS NOT NULL THEN 'ai'
             ELSE NULL END AS phrase_source,
        COALESCE(matched_phrase, label) AS phrase,
        COUNT(*)::bigint AS count
      FROM classifier_decisions
      WHERE needs_response = false
        AND (matched_phrase IS NOT NULL OR (reason = 'ai' AND label IS NOT NULL))
      GROUP BY phrase_source, phrase
      ORDER BY count DESC
      LIMIT 50
    `);
    const recentP = pool.query(
      `SELECT EXTRACT(EPOCH FROM at) * 1000 AS at_ms,
              engagement_id, engagement_type, source, reason, confidence,
              label, matched_phrase, needs_response, preview
       FROM classifier_decisions
       ORDER BY at DESC
       LIMIT $1`,
      [recentLimit]
    );
    const [totalsR, phrasesR, recentR] = await Promise.all([totalsP, phrasesP, recentP]);
    const t = totalsR.rows[0] || {};
    return {
      total: Number(t.total || 0),
      cacheHits: Number(t.cache_hits || 0),
      invocations: {
        keyword: Number(t.inv_keyword || 0),
        ai: Number(t.inv_ai || 0),
        fallback: Number(t.inv_fallback || 0),
      },
      byOutcome: {
        acknowledgment: Number(t.acknowledgment || 0),
        needs_response: Number(t.needs_response || 0),
      },
      startedAtMs: t.started_at_ms ? Number(t.started_at_ms) : null,
      ackPhraseCounts: phrasesR.rows.map((r) => ({
        phrase: r.phrase,
        source: r.phrase_source,
        count: Number(r.count),
      })),
      recent: recentR.rows.map((r) => ({
        at: Number(r.at_ms),
        engagementId: r.engagement_id,
        type: r.engagement_type,
        source: r.source,
        reason: r.reason,
        confidence: r.confidence,
        label: r.label,
        matchedPhrase: r.matched_phrase,
        needsResponse: r.needs_response,
        preview: r.preview,
      })),
    };
  } catch (err) {
    console.error("[classifier-store] load error:", err.message);
    return null;
  }
}

async function pruneClassifierDecisions(retentionDays = 90) {
  try {
    await ensureClassifierTable();
    const result = await getPool().query(
      `DELETE FROM classifier_decisions WHERE at < NOW() - ($1 || ' days')::INTERVAL`,
      [String(retentionDays)]
    );
    if (result.rowCount > 0) {
      console.log(`[classifier-store] pruned ${result.rowCount} decisions older than ${retentionDays}d`);
    }
    return result.rowCount;
  } catch (err) {
    console.error("[classifier-store] prune error:", err.message);
    return 0;
  }
}

async function deleteAllClassifierDecisions() {
  try {
    await ensureClassifierTable();
    await getPool().query(`DELETE FROM classifier_decisions`);
  } catch (err) {
    console.error("[classifier-store] delete all error:", err.message);
  }
}

module.exports = {
  getDbCache,
  getDbCacheWithStale,
  setDbCache,
  clearDbCache,
  getDbCacheMeta,
  ensureClassifierTable,
  insertClassifierDecision,
  loadClassifierState,
  pruneClassifierDecisions,
  deleteAllClassifierDecisions,
};
