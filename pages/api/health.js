// Lightweight, dependency-free health endpoint. Hits NO database, NO
// HubSpot, and NO cache layer. Returns immediately so:
//   1. The uptime monitor has a fast, cheap target that always works
//      regardless of cache/DB state.
//   2. The log line below confirms in production logs that HTTP
//      requests are reaching the Node process at all (production
//      `next start` does not log requests by default, so silence in
//      logs has been ambiguous between "no requests arriving" vs.
//      "requests served fine".
//   3. We surface live process memory / uptime so we can spot a leak
//      or pinpoint the moment of degradation.

export default function handler(req, res) {
  const mem = process.memoryUsage();
  const payload = {
    ok: true,
    now: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    rssMB: Math.round(mem.rss / 1024 / 1024),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
    pid: process.pid,
  };
  console.log(
    `[health] ok pid=${payload.pid} up=${payload.uptimeSec}s rss=${payload.rssMB}MB heap=${payload.heapUsedMB}/${payload.heapTotalMB}MB`
  );
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(payload);
}
