export async function register() {
  // Auto-warmup and the 2-hour scheduled refresh have been disabled. The
  // dashboard now serves whatever is in the persistent DB cache, and the
  // user manually triggers a fresh HubSpot pull via the refresh button
  // (POST /api/refresh). This keeps the server lightweight at startup so
  // the container stays reachable.
}
