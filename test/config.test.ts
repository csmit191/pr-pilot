import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  WEBHOOK_SECRET: "s",
  GITHUB_APP_ID: "42",
  GITHUB_PRIVATE_KEY: "line1\\nline2",
};

describe("loadConfig", () => {
  it("reads required values and applies defaults", () => {
    expect(loadConfig(base)).toEqual({
      port: 3000,
      webhookSecret: "s",
      appId: 42,
      privateKey: "line1\nline2",
      anthropicApiKey: undefined,
      llmModel: "claude-haiku-5-5",
    });
  });

  it.each(["WEBHOOK_SECRET", "GITHUB_APP_ID", "GITHUB_PRIVATE_KEY"])("fails fast when %s is missing", (name) => {
    const env: Record<string, string | undefined> = { ...base, [name]: undefined };
    expect(() => loadConfig(env)).toThrow(name);
  });

  it("reads the optional LLM settings", () => {
    const config = loadConfig({ ...base, ANTHROPIC_API_KEY: "k", LLM_MODEL: "some-model", PORT: "8080" });
    expect(config).toMatchObject({ anthropicApiKey: "k", llmModel: "some-model", port: 8080 });
  });

  it("treats empty optional values as unset (as in a copied .env.example)", () => {
    const config = loadConfig({ ...base, ANTHROPIC_API_KEY: "", LLM_MODEL: "" });
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.llmModel).toBe("claude-haiku-5-5");
  });
});
