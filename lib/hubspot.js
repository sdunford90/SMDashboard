const https = require("https");

// instrumentation.js installs the keepAlive https.Agent, monkey-patches
// node-fetch via require.cache, and assigns https.globalAgent at server
// startup (before any pages or API routes run, thanks to Next.js's
// instrumentationHook). We deliberately DON'T repeat that work here:
// re-creating the agent and re-patching node-fetch would leave a second
// orphaned https.Agent instance behind that the SDK never uses, leaking
// its TLS socket pool.
//
// In the unlikely case lib/hubspot.js is loaded outside the Next.js
// runtime (scripts, tests) and instrumentation.js never ran, ensure we
// still have a keepAlive agent so the SDK's per-request fetches don't
// re-handshake TLS each time.
function ensureKeepAliveAgent() {
  const ga = https.globalAgent;
  // Recreate if the global agent is missing, isn't keepAlive, or has
  // been destroyed (e.g. by something downstream calling .destroy()).
  // A destroyed Agent silently breaks every subsequent request, so we
  // never want to hand a dead one to the SDK.
  if (!ga || ga.keepAlive !== true || ga.destroyed === true) {
    https.globalAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 6,
      maxFreeSockets: 2,
    });
  }
  return https.globalAgent;
}

const hubspot = require("@hubspot/api-client");

let client = null;

function getHubSpotClient() {
  if (!client) {
    if (!process.env.HUBSPOT_API_TOKEN) {
      throw new Error("HUBSPOT_API_TOKEN environment variable is not set");
    }
    client = new hubspot.Client({
      accessToken: process.env.HUBSPOT_API_TOKEN,
      httpAgent: ensureKeepAliveAgent(),
    });
  }
  return client;
}

module.exports = { getHubSpotClient };
