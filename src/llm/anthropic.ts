import { z } from "zod";
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from "./provider.js";

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable so tests never touch the network. */
  fetch?: typeof fetch;
}

// Only what we read from the response.
const responseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

const errorSchema = z.object({ error: z.object({ type: z.string() }) });

export function createAnthropicProvider(options: AnthropicOptions): LlmProvider {
  const { apiKey, model, baseUrl = DEFAULT_BASE_URL, timeoutMs = 60_000 } = options;
  const fetchFn = options.fetch ?? fetch;

  return {
    name: "anthropic",
    model,

    async complete(request: LlmRequest): Promise<LlmResponse> {
      let response: Response;
      try {
        response = await fetchFn(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages: [{ role: "user", content: request.user }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Network failure or timeout. Report the cause, never the request (it holds code and the key).
        const cause = err instanceof Error ? err.name : "unknown error";
        throw new LlmError(`Anthropic API request failed (${cause})`);
      }

      if (!response.ok) {
        // Include only the error *type* (e.g. rate_limit_error), not the body or any request data.
        const body = errorSchema.safeParse(await response.json().catch(() => null));
        const type = body.success ? `, ${body.data.error.type}` : "";
        throw new LlmError(`Anthropic API error (HTTP ${response.status}${type})`, response.status);
      }

      const parsed = responseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new LlmError("Anthropic API returned an unexpected response shape");

      const text = parsed.data.content
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");

      return {
        text,
        usage: {
          inputTokens: parsed.data.usage.input_tokens,
          outputTokens: parsed.data.usage.output_tokens,
        },
      };
    },
  };
}
