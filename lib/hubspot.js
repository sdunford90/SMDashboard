const hubspot = require("@hubspot/api-client");
const https = require("https");

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 6,
  maxFreeSockets: 4,
});

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
