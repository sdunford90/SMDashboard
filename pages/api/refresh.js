import { forceRefresh, _recheckUnrespondedEngagements } from "../../lib/leads";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const force = req.query.force === "true" || req.body?.force === true;
  const backfill = req.query.backfill === "true" || req.body?.backfill === true;

  if (backfill) {
    // Run a fully unbounded recheck pass over every unresponded lead
    // with empty engagements (no time bound, no row cap). Used after
    // an upstream HubSpot association issue is fixed to mop up
    // everything that drifted into a stale state.
    _recheckUnrespondedEngagements({ recentDays: 0, limit: 0 })
      .then(() => console.log("[api/refresh] Manual backfill recheck complete."))
      .catch((err) =>
        console.error("[api/refresh] Manual backfill recheck failed:", err.message)
      );
    return res
      .status(200)
      .json({ success: true, message: "backfill recheck started" });
  }

  const mode = force ? "full" : "incremental";

  forceRefresh({ force })
    .then(() => console.log(`[api/refresh] Manual ${mode} refresh complete.`))
    .catch((err) =>
      console.error(`[api/refresh] Manual ${mode} refresh failed:`, err.message)
    );

  res.status(200).json({ success: true, message: `${mode} refresh started` });
}
