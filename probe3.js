const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
(async () => {
  const c = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE data->>'firstReferrer' IS NOT NULL AND data->>'firstReferrer' != '') AS with_ref,
      COUNT(*) FILTER (WHERE data->>'firstUrl' IS NOT NULL AND data->>'firstUrl' != '') AS with_url
    FROM leads
  `);
  console.log('Cache stats:', c.rows[0]);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
