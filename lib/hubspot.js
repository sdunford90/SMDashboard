const hubspot = require("@hubspot/api-client");

let client = null;

function getHubSpotClient() {
  if (!client) {
    if (!process.env.HUBSPOT_API_TOKEN) {
      throw new Error("HUBSPOT_API_TOKEN environment variable is not set");
    }
    client = new hubspot.Client({
      accessToken: process.env.HUBSPOT_API_TOKEN,
    });
  }
  return client;
}

module.exports = { getHubSpotClient };
