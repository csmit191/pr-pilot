import { loadConfig } from "./config.js";
import { createGithubClient } from "./github.js";
import { handlePullRequest } from "./handlers/pullRequest.js";
import { createAnthropicProvider } from "./llm/anthropic.js";
import { summarizePullRequest, type SummarizeFn } from "./llm/summarize.js";
import { logger } from "./logger.js";
import { createWebhookServer } from "./server.js";

const config = loadConfig();
const github = createGithubClient(config);

let summarize: SummarizeFn | undefined;
if (config.anthropicApiKey) {
  const provider = createAnthropicProvider({ apiKey: config.anthropicApiKey, model: config.llmModel });
  summarize = (input) => summarizePullRequest(input, provider);
  logger.info("LLM summaries enabled", { provider: provider.name, model: provider.model });
} else {
  logger.warn("ANTHROPIC_API_KEY is not set; LLM summaries are disabled");
}

const server = createWebhookServer({
  secret: config.webhookSecret,
  onEvent: async ({ name, deliveryId, payload }) => {
    logger.info("Webhook accepted", { event: name, deliveryId });
    if (name === "pull_request") {
      await handlePullRequest(payload, { ...github, summarize, appId: config.appId });
    }
  },
});

server.listen(config.port, () => logger.info("PR Pilot listening", { port: config.port }));
