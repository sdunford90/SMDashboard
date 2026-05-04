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
      // Cap how long any single statement can run server-side. Set
      // larger than the JS-side queryWithTimeout default so the JS
      // side aborts first (and we get a clean error path) rather than
      // the server killing the query mid-stream.
      statement_timeout: 30_000,
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
//
// IMPORTANT: when the JS timeout fires the underlying client.query()
// is still in flight on the pg client. If we returned that client to
// the pool with a plain .release(), the next request would pick it up
// and queue behind the doomed query — quickly exhausting the pool and
// hanging every subsequent request. We must call release(err) with a
// truthy argument so pg destroys the client and opens a fresh one.
async function queryWithTimeout(text, params, timeoutMs = 8000) {
  const client = await getPool().connect();
  let timedOut = false;
  try {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`db query timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([client.query(text, params), timeout]);
      return result;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    timedOut = true;
    throw err;
  } finally {
    // Pass a truthy value to release() so pg discards the half-broken
    // client instead of returning it to the pool with an in-flight
    // query still attached. This is what prevents pool poisoning after
    // a timeout.
    client.release(timedOut ? new Error("query aborted by client timeout") : undefined);
  }
}

const DB_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// The hubspot_cache row holds a multi-megabyte JSONB blob (every lead
// across every marina). Pulling that over the network from a remote
// Postgres in a cold container can legitimately take 10-20 seconds, so
// we use a generous timeout for cache reads — falling back too early
// just means every concurrent dashboard request re-pays the same cost.
const CACHE_READ_TIMEOUT_MS = 25_000;

// Dedupe concurrent reads of the same cache key so a single dashboard
// page-load (which fans out to 5+ API endpoints in parallel) doesn't
// trigger 5+ identical multi-megabyte SELECTs against the same row.
// Each call awaits the same in-flight promise; once it resolves the
// entry is cleared so the next cold request can re-read.
const _inFlightReads = new Map();
function _dedupedRead(key, fn) {
  const existing = _inFlightReads.get(key);
  if (existing) return existing;
  const p = fn().finally(() => {
    _inFlightReads.delete(key);
  });
  _inFlightReads.set(key, p);
  return p;
}

async function getDbCache(key) {
  return _dedupedRead("fresh:" + key, async () => {
    try {
      const result = await queryWithTimeout(
        "SELECT data FROM hubspot_cache WHERE key = $1 AND expires_at > NOW()",
        [key],
        CACHE_READ_TIMEOUT_MS
      );
      if (result.rows.length > 0) {
        return result.rows[0].data;
      }
    } catch (err) {
      console.error("[db-cache] read error:", err.message);
    }
    return null;
  });
}

// Returns data even if expired, plus an `isStale` flag
async function getDbCacheWithStale(key) {
  return _dedupedRead("stale:" + key, async () => {
    try {
      const result = await queryWithTimeout(
        "SELECT data, expires_at > NOW() AS fresh FROM hubspot_cache WHERE key = $1",
        [key],
        CACHE_READ_TIMEOUT_MS
      );
      if (result.rows.length > 0) {
        return { data: result.rows[0].data, isStale: !result.rows[0].fresh };
      }
    } catch (err) {
      console.error("[db-cache] read error:", err.message);
    }
    return null;
  });
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

let _leadsTablesReady = null;

async function ensureLeadsTables() {
  if (_leadsTablesReady) return _leadsTablesReady;
  _leadsTablesReady = (async () => {
    const p = getPool();
    const ddl = [
      `CREATE TABLE IF NOT EXISTS leads (
        contact_id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_leads_marina ON leads ((data->>'marina'))`,
      `CREATE TABLE IF NOT EXISTS engagements (
        engagement_id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        type TEXT NOT NULL,
        direction TEXT,
        timestamp TIMESTAMPTZ,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_engagements_contact_id ON engagements (contact_id)`,
      `CREATE INDEX IF NOT EXISTS idx_engagements_timestamp ON engagements (timestamp)`,
      `CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        last_sync_at TIMESTAMPTZ NOT NULL,
        contact_count INTEGER DEFAULT 0,
        engagement_count INTEGER DEFAULT 0
      )`,
    ];
    for (const stmt of ddl) {
      try { await p.query(stmt); } catch (e) {
        const isDuplicate = e.code === '42P07' || e.code === '42710' ||
          (e.code === '23505' && e.constraint && e.constraint.includes('pg_type'));
        if (!isDuplicate) throw e;
      }
    }
  })().catch((err) => {
    console.error("[leads-tables] ensure error:", err.message);
    _leadsTablesReady = null;
    throw err;
  });
  return _leadsTablesReady;
}

async function upsertLeadRows(leads) {
  if (!leads || leads.length === 0) return;
  await ensureLeadsTables();
  const p = getPool();
  const CHUNK = 50;
  for (let i = 0; i < leads.length; i += CHUNK) {
    const batch = leads.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    batch.forEach((lead, idx) => {
      const off = idx * 2;
      values.push(`($${off + 1}, $${off + 2}, NOW())`);
      params.push(lead.contactId, JSON.stringify(lead));
    });
    await p.query(
      `INSERT INTO leads (contact_id, data, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (contact_id) DO UPDATE
         SET data = EXCLUDED.data, updated_at = NOW()`,
      params
    );
  }
}

async function upsertEngagementRows(contactId, engagements) {
  if (!engagements || engagements.length === 0) return;
  await ensureLeadsTables();
  const p = getPool();
  const CHUNK = 100;
  for (let i = 0; i < engagements.length; i += CHUNK) {
    const batch = engagements.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    batch.forEach((eng, idx) => {
      const off = idx * 6;
      values.push(`($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6}::timestamptz, NOW())`);
      params.push(
        eng.engagementId,
        contactId,
        eng.type,
        eng.direction || null,
        JSON.stringify(eng),
        eng.timestamp ? new Date(eng.timestamp).toISOString() : null
      );
    });
    await p.query(
      `INSERT INTO engagements (engagement_id, contact_id, type, direction, data, timestamp, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (engagement_id) DO UPDATE
         SET data = EXCLUDED.data, contact_id = EXCLUDED.contact_id,
             direction = EXCLUDED.direction, updated_at = NOW()`,
      params
    );
  }
}

async function getEngagementsForContact(contactId) {
  try {
    await ensureLeadsTables();
    const result = await getPool().query(
      `SELECT data FROM engagements WHERE contact_id = $1 ORDER BY timestamp ASC`,
      [contactId]
    );
    return result.rows.map((r) =>
      typeof r.data === "string" ? JSON.parse(r.data) : r.data
    );
  } catch (err) {
    console.error("[leads-tables] getEngagementsForContact error:", err.message);
    return [];
  }
}

async function getDbLeadAndEngagementCounts() {
  try {
    await ensureLeadsTables();
    const [lcRes, ecRes] = await Promise.all([
      getPool().query("SELECT COUNT(*)::int AS c FROM leads"),
      getPool().query("SELECT COUNT(*)::int AS c FROM engagements"),
    ]);
    return { leadCount: lcRes.rows[0].c, engagementCount: ecRes.rows[0].c };
  } catch (err) {
    console.error("[leads-tables] getDbLeadAndEngagementCounts error:", err.message);
    return null;
  }
}

async function getExistingEngagementIds(contactId) {
  try {
    await ensureLeadsTables();
    const result = await getPool().query(
      `SELECT engagement_id FROM engagements WHERE contact_id = $1`,
      [contactId]
    );
    return new Set(result.rows.map((r) => r.engagement_id));
  } catch (err) {
    console.error("[leads-tables] getExistingEngagementIds error:", err.message);
    return new Set();
  }
}

async function getAllLeadsFromDb() {
  try {
    await ensureLeadsTables();
    const leadsResult = await queryWithTimeout(
      `SELECT contact_id, data FROM leads WHERE COALESCE(data->>'isSpam', 'false') != 'true' ORDER BY (data->>'createDate') DESC`,
      [],
      CACHE_READ_TIMEOUT_MS
    );
    if (leadsResult.rows.length === 0) return null;

    const leads = leadsResult.rows.map((r) => {
      const d = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
      return d;
    });

    const engResult = await queryWithTimeout(
      `SELECT contact_id, data FROM engagements ORDER BY timestamp ASC`,
      [],
      CACHE_READ_TIMEOUT_MS
    );
    const engsByContact = {};
    for (const row of engResult.rows) {
      const d = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
      if (!engsByContact[row.contact_id]) engsByContact[row.contact_id] = [];
      engsByContact[row.contact_id].push(d);
    }

    for (const lead of leads) {
      lead.engagements = engsByContact[lead.contactId] || [];
    }

    const byMarina = {};
    for (const lead of leads) {
      const m = lead.marina || "Unknown";
      if (!byMarina[m]) byMarina[m] = [];
      byMarina[m].push(lead);
    }

    return { leads, byMarina };
  } catch (err) {
    console.error("[leads-tables] getAllLeadsFromDb error:", err.message);
    return null;
  }
}

async function getSyncState() {
  try {
    await ensureLeadsTables();
    const result = await getPool().query(
      `SELECT last_sync_at, contact_count, engagement_count FROM sync_state WHERE key = 'hubspot'`
    );
    if (result.rows.length > 0) {
      return {
        lastSyncAt: result.rows[0].last_sync_at,
        contactCount: result.rows[0].contact_count,
        engagementCount: result.rows[0].engagement_count,
      };
    }
  } catch (err) {
    console.error("[leads-tables] getSyncState error:", err.message);
  }
  return null;
}

async function setSyncState(contactCount, engagementCount, syncTimestamp) {
  try {
    await ensureLeadsTables();
    const ts = syncTimestamp ? new Date(syncTimestamp).toISOString() : new Date().toISOString();
    await getPool().query(
      `INSERT INTO sync_state (key, last_sync_at, contact_count, engagement_count)
       VALUES ('hubspot', $3::timestamptz, $1, $2)
       ON CONFLICT (key) DO UPDATE
         SET last_sync_at = $3::timestamptz, contact_count = $1, engagement_count = $2`,
      [contactCount, engagementCount, ts]
    );
  } catch (err) {
    console.error("[leads-tables] setSyncState error:", err.message);
  }
}

async function clearSyncState() {
  try {
    await ensureLeadsTables();
    await getPool().query(`DELETE FROM sync_state WHERE key = 'hubspot'`);
  } catch (err) {
    console.error("[leads-tables] clearSyncState error:", err.message);
  }
}

async function deleteLeadAndEngagements(contactId) {
  try {
    await ensureLeadsTables();
    const p = getPool();
    await p.query(`DELETE FROM engagements WHERE contact_id = $1`, [contactId]);
    await p.query(`DELETE FROM leads WHERE contact_id = $1`, [contactId]);
  } catch (err) {
    console.error("[leads-tables] deleteLeadAndEngagements error:", err.message);
  }
}

async function clearLeadsTables() {
  try {
    await ensureLeadsTables();
    const p = getPool();
    await p.query(`DELETE FROM engagements`);
    await p.query(`DELETE FROM leads`);
    await p.query(`DELETE FROM sync_state WHERE key = 'hubspot'`);
  } catch (err) {
    console.error("[leads-tables] clearLeadsTables error:", err.message);
  }
}

module.exports = {
  getPool,
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
  ensureLeadsTables,
  upsertLeadRows,
  upsertEngagementRows,
  getEngagementsForContact,
  getDbLeadAndEngagementCounts,
  getExistingEngagementIds,
  getAllLeadsFromDb,
  getSyncState,
  setSyncState,
  clearSyncState,
  clearLeadsTables,
  deleteLeadAndEngagements,
};
