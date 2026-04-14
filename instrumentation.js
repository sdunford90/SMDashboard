export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getAllLeadsData, forceRefresh } = await import("./lib/leads.js");
    console.log("[warmup] Pre-loading HubSpot data into cache (background)...");
    getAllLeadsData()
      .then(() => console.log("[warmup] Cache warm — leads data ready."))
      .catch((err) => console.error("[warmup] Failed to pre-load cache:", err.message));

    const TWO_HOURS = 2 * 60 * 60 * 1000;
    setInterval(() => {
      console.log("[scheduler] Running scheduled 2-hour HubSpot refresh...");
      forceRefresh()
        .then(() => console.log("[scheduler] Scheduled refresh complete."))
        .catch((err) => console.error("[scheduler] Scheduled refresh failed:", err.message));
    }, TWO_HOURS);
  }
}
