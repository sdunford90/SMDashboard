export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const https = require("https");

    // Single shared keepAlive agent for ALL outbound HTTPS in this
    // process: HubSpot SDK, Anthropic SDK, anything that goes through
    // https.globalAgent or node-fetch. Tight maxFreeSockets keeps the
    // idle TLS socket pool small — every idle TLS socket holds tens of
    // KB of buffers, and on a 2GB VM those add up fast.
    const agent = new https.Agent({
      keepAlive: true,
      maxSockets: 6,
      maxFreeSockets: 2,
    });
    https.globalAgent = agent;

    const originalFetch = require("node-fetch");
    const patchedFetch = function (url, opts = {}) {
      if (!opts.agent) {
        opts = { ...opts, agent };
      }
      return originalFetch(url, opts);
    };
    patchedFetch.default = patchedFetch;
    for (const key of Object.keys(originalFetch)) {
      if (!(key in patchedFetch)) patchedFetch[key] = originalFetch[key];
    }
    const resolvedPath = require.resolve("node-fetch");
    require.cache[resolvedPath] = {
      id: resolvedPath,
      filename: resolvedPath,
      loaded: true,
      exports: patchedFetch,
    };
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

    // --- Memory hygiene (Task #27) ---
    //
    // Production was running 2.5–4.7 GB RSS on a 2 GB VM, way above the
    // 1 GB V8 heap cap. The bulk of that excess is non-V8 memory:
    //   - glibc allocator fragmentation across many ptmalloc arenas
    //     (one per CPU × 8 by default), each holding onto freed memory
    //     instead of returning it to the OS
    //   - TLS socket read/write buffers held by keepAlive sockets that
    //     never get recycled
    //   - libuv worker pool & pg buffer pools
    //
    // Fixes that go with this code path:
    //   - MALLOC_ARENA_MAX=2 in the npm start script: caps glibc to a
    //     single allocator pool, the single biggest RSS reduction lever
    //     for steady-state Node.js workloads.
    //   - --max-old-space-size=768 + --max-semi-space-size=32: tightens
    //     V8 so the GC runs more often and gives memory back sooner.
    //   - Periodic idle-socket release below: every 30 minutes we walk
    //     agent.freeSockets and destroy only the idle TLS sockets so
    //     their buffers get freed back to the OS. The agent itself and
    //     in-flight `agent.sockets` are never touched.
    //   - Periodic global.gc() if RSS climbs past a soft threshold:
    //     prods V8 to compact + return pages to the OS.

    // Recycle ONLY idle keepAlive sockets — never call agent.destroy()
    // here. agent.destroy() is terminal: it tears down the agent, force-
    // closes active in-flight sockets, and leaves the global agent in a
    // state where subsequent requests fail. We just want to free the
    // per-socket TLS read/write buffers (~tens of KB each) sitting on
    // long-idle keepAlive connections; the agent itself stays alive and
    // will lazily open a fresh TLS handshake on the next request.
    const SOCKET_RECYCLE_MS = 30 * 60 * 1000; // every 30 min
    const sockTimer = setInterval(() => {
      try {
        let closed = 0;
        const freeSockets = agent.freeSockets || {};
        for (const key of Object.keys(freeSockets)) {
          const list = freeSockets[key] || [];
          // Snapshot before iterating: socket.destroy() emits 'close',
          // which Node's Agent removes the socket from this same array
          // mid-loop. Iterating the snapshot keeps things deterministic.
          for (const sock of list.slice()) {
            try {
              sock.destroy();
              closed++;
            } catch (_) { /* ignore individual socket errors */ }
          }
        }
        const usedCount = Object.values(agent.sockets || {}).reduce(
          (n, arr) => n + (arr ? arr.length : 0),
          0
        );
        if (closed > 0 || usedCount > 0) {
          console.log(
            `[mem] released ${closed} idle TLS sockets (active in-flight=${usedCount})`
          );
        }
      } catch (err) {
        console.warn("[mem] socket recycle error:", err.message);
      }
    }, SOCKET_RECYCLE_MS);
    if (sockTimer.unref) sockTimer.unref();

    // Soft RSS threshold — call gc() if we cross it. 1.5 GB matches
    // the "Done looks like" target in Task #27. Below the threshold gc
    // is skipped so we don't pay the pause time when memory is healthy.
    const RSS_GC_THRESHOLD_BYTES = 1.2 * 1024 * 1024 * 1024;
    const HEARTBEAT_MS = 5 * 60 * 1000; // every 5 min (was 10)
    const hb = setInterval(() => {
      const mem = process.memoryUsage();
      const rssMB = Math.round(mem.rss / 1048576);
      const heapUsedMB = Math.round(mem.heapUsed / 1048576);
      const heapTotalMB = Math.round(mem.heapTotal / 1048576);
      let gcRan = false;
      if (mem.rss > RSS_GC_THRESHOLD_BYTES && typeof global.gc === "function") {
        try {
          global.gc();
          gcRan = true;
        } catch (err) {
          console.warn("[mem] gc() failed:", err.message);
        }
      }
      const after = gcRan ? process.memoryUsage() : null;
      const afterStr = after
        ? ` -> rss=${Math.round(after.rss / 1048576)}MB heap=${Math.round(after.heapUsed / 1048576)}MB (post-gc)`
        : "";
      console.log(
        `[heartbeat] pid=${process.pid} up=${Math.round(process.uptime())}s` +
        ` rss=${rssMB}MB heap=${heapUsedMB}/${heapTotalMB}MB${afterStr}`
      );
    }, HEARTBEAT_MS);
    if (hb.unref) hb.unref();
  }
}
