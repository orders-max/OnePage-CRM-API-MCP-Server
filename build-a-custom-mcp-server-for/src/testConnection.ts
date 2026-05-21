import { loadConfig } from "./config.js";
import { OnePageCrmClient } from "./onePageCrmClient.js";

try {
  const config = loadConfig();
  const client = new OnePageCrmClient(config);
  await client.testConnection();
  console.log("Connection OK. OnePage CRM accepted the endpoint, user ID, and API key.");
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Connection failed: ${message}`);
  process.exitCode = 1;
}
