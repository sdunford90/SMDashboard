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

module.exports = { getDbCache, getDbCacheWithStale, setDbCache, clearDbCache, getDbCacheMeta };
