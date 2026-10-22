import { loadConfig } from "./config.js";
import { createGithubClient } from "./github.js";
import { handlePullRequest } from "./handlers/pullRequest.js";
import { createAnthropicProvider } from "./llm/anthropic.js";
import { summarizePullRequest, type SummarizeFn } from "./llm/summarize.js";
import { logger } from "./logger.js";
import { createWebhookServer } from "./server.js";
import { createShutdownHandler } from "./shutdown.js";
import { createInFlightTracker } from "./util/inflight.js";

/** Hosts send SIGTERM and kill the process shortly after, so we stay well inside a ~30 s window. */
const SHUTDOWN_GRACE_MS = 25_000;

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

const tracker = createInFlightTracker();

const server = createWebhookServer({
  secret: config.webhookSecret,
  tracker,
  onEvent: async ({ name, deliveryId, payload }) => {
    logger.info("Webhook accepted", { event: name, deliveryId });
    if (name === "pull_request") {
      await handlePullRequest(payload, { ...github, summarize, appId: config.appId });
    }
  },
});

// A deploy (or Ctrl+C) must not kill a review halfway: stop taking webhooks, finish what is running.
const shutdown = createShutdownHandler({
  server,
  tracker,
  graceMs: SHUTDOWN_GRACE_MS,
  log: logger,
  exit: (code) => process.exit(code),
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}

server.listen(config.port, () => logger.info("PR Pilot listening", { port: config.port }));
