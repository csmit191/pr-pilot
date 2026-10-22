import { loadConfig } from "./config.js";
import { createGithubClient } from "./github.js";
import { handlePullRequest } from "./handlers/pullRequest.js";
import { logger } from "./logger.js";
import { createWebhookServer } from "./server.js";

const config = loadConfig();
const github = createGithubClient(config);

const server = createWebhookServer({
  secret: config.webhookSecret,
  onEvent: async ({ name, deliveryId, payload }) => {
    logger.info("Webhook accepted", { event: name, deliveryId });
    if (name === "pull_request") await handlePullRequest(payload, github);
  },
});

server.listen(config.port, () => logger.info("PR Pilot listening", { port: config.port }));
