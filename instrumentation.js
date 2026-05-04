export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Auto-warmup and the 2-hour scheduled HubSpot refresh have been disabled.
    // The dashboard now serves whatever is in the persistent DB cache, and the
    // user manually triggers a fresh HubSpot pull via the refresh button
    // (POST /api/refresh). This keeps the server lightweight at startup so
    // the container stays reachable.
    //
    // Classifier metrics persistence still runs at boot: it restores the
    // Reply Classifier stats from the DB so the Insights card has accurate
    // lifetime numbers, and it starts the periodic prune for old decisions.
    const { initClassifierMetrics, startClassifierPruneScheduler } = await import("./lib/ack-classifier.js");
    initClassifierMetrics()
      .then(() => console.log("[warmup] Classifier metrics restored from DB."))
      .catch((err) => console.error("[warmup] Classifier init failed:", err.message));
    startClassifierPruneScheduler();

    process.on("uncaughtException", (err) => {
      console.error("[FATAL] uncaughtException — process will exit:", err?.stack || err);
      process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
      console.error("[FATAL] unhandledRejection:", reason?.stack || reason);
    });

    const HEARTBEAT_MS = 10 * 60 * 1000;
    const hb = setInterval(() => {
      const mem = process.memoryUsage();
      console.log(
        `[heartbeat] pid=${process.pid} up=${Math.round(process.uptime())}s` +
        ` rss=${Math.round(mem.rss/1024/1024)}MB` +
        ` heap=${Math.round(mem.heapUsed/1024/1024)}/${Math.round(mem.heapTotal/1024/1024)}MB`
      );
    }, HEARTBEAT_MS);
    if (hb.unref) hb.unref();
  }
}
