export interface Config {
  port: number;
  webhookSecret: string;
  appId: number;
  privateKey: string;
  /** Optional: without it the app still works, it just skips LLM summaries. */
  anthropicApiKey: string | undefined;
  llmModel: string;
}

/** Reads config from env vars only. Fails fast at startup if anything required is missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
  };

  return {
    port: Number(env.PORT ?? 3000),
    webhookSecret: required("WEBHOOK_SECRET"),
    appId: Number(required("GITHUB_APP_ID")),
    // .env files can't hold real newlines in one line, so we store "\n" and expand it here.
    privateKey: required("GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n"),
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    // Check Anthropic's models page for current IDs; override with LLM_MODEL without code changes.
    llmModel: env.LLM_MODEL || "claude-haiku-5-5",
  };
}
