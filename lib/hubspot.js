const https = require("https");

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 6,
  maxFreeSockets: 4,
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
require.cache[require.resolve("node-fetch")] = {
  id: require.resolve("node-fetch"),
  filename: require.resolve("node-fetch"),
  loaded: true,
  exports: patchedFetch,
};

const hubspot = require("@hubspot/api-client");

let client = null;

function getHubSpotClient() {
  if (!client) {
    if (!process.env.HUBSPOT_API_TOKEN) {
      throw new Error("HUBSPOT_API_TOKEN environment variable is not set");
    }
    client = new hubspot.Client({
      accessToken: process.env.HUBSPOT_API_TOKEN,
      httpAgent: agent,
    });
  }
  return client;
}

module.exports = { getHubSpotClient };
