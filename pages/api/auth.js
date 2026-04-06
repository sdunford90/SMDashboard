export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { password } = req.body;

  if (!password || password !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }

  // Set session cookie with 24-hour expiry
  const token = Buffer.from(
    `sm_session_${Date.now()}_${process.env.DASHBOARD_PASSWORD}`
  ).toString("base64");

  res.setHeader(
    "Set-Cookie",
    `sm_dash_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24}`
  );

  res.status(200).json({ success: true });
}
