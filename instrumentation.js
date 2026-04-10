export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getAllLeadsData } = await import("./lib/leads.js");
    console.log("[warmup] Pre-loading HubSpot data into cache (background)...");
    getAllLeadsData()
      .then(() => console.log("[warmup] Cache warm — leads data ready."))
      .catch((err) => console.error("[warmup] Failed to pre-load cache:", err.message));
  }
}
