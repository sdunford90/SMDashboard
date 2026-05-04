import { forceRefresh } from "../../lib/leads";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const force = req.query.force === "true" || req.body?.force === true;
  const mode = force ? "full" : "incremental";

  forceRefresh({ force })
    .then(() => console.log(`[api/refresh] Manual ${mode} refresh complete.`))
    .catch((err) => console.error(`[api/refresh] Manual ${mode} refresh failed:`, err.message));

  res.status(200).json({ success: true, message: `${mode} refresh started` });
}
