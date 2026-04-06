const { Pool } = require("pg");

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    pool.on("error", (err) => {
      console.error("[db-pool] idle client error:", err.message);
    });
  }
  return pool;
}

const DB_CACHE_TTL_MS = 5 * 60 * 1000;

async function getDbCache(key) {
  try {
    const result = await getPool().query(
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

module.exports = { getDbCache, setDbCache, clearDbCache };
