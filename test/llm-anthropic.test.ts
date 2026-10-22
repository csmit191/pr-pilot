import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../src/llm/anthropic.js";
import { LlmError } from "../src/llm/provider.js";

const API_KEY = "test-key-" + "do-not-leak-12345";
const request = { system: "SYSTEM TEXT", user: "USER TEXT with private code", maxTokens: 321 };

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const okBody = {
  content: [{ type: "text", text: '{"ok":true}' }],
  usage: { input_tokens: 42, output_tokens: 7 },
};

const provider = (f: typeof fetch, extra: Record<string, unknown> = {}) =>
  createAnthropicProvider({ apiKey: API_KEY, model: "claude-test-1", fetch: f, ...extra });

describe("createAnthropicProvider", () => {
  it("exposes its name and model", () => {
    const p = provider(fakeFetch(() => json(okBody)).fetch);
    expect(p.name).toBe("anthropic");
    expect(p.model).toBe("claude-test-1");
  });

  it("sends the documented request shape", async () => {
    const f = fakeFetch(() => json(okBody));
    await provider(f.fetch).complete(request);

    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    });
    expect(JSON.parse(call.init.body as string)).toEqual({
      model: "claude-test-1",
      max_tokens: 321,
      system: "SYSTEM TEXT",
      messages: [{ role: "user", content: "USER TEXT with private code" }],
    });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the text and token usage", async () => {
    const result = await provider(fakeFetch(() => json(okBody)).fetch).complete(request);
    expect(result).toEqual({ text: '{"ok":true}', usage: { inputTokens: 42, outputTokens: 7 } });
  });

  it("joins text blocks and ignores other block types", async () => {
    const body = {
      content: [
        { type: "text", text: "Hello " },
        { type: "tool_use", id: "x" },
        { type: "text", text: "world" },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const result = await provider(fakeFetch(() => json(body)).fetch).complete(request);
    expect(result.text).toBe("Hello world");
  });

  it("honors a custom base URL", async () => {
    const f = fakeFetch(() => json(okBody));
    await provider(f.fetch, { baseUrl: "http://localhost:9999" }).complete(request);
    expect(f.calls[0]?.url).toBe("http://localhost:9999/v1/messages");
  });

  it("raises LlmError with the status and error type on an HTTP error", async () => {
    const f = fakeFetch(() => json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429));
    const err = await provider(f.fetch).complete(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).status).toBe(429);
    expect((err as LlmError).message).toContain("429");
    expect((err as LlmError).message).toContain("rate_limit_error");
  });

  it("copes with an HTTP error whose body is not JSON", async () => {
    const f = fakeFetch(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    const err = (await provider(f.fetch).complete(request).catch((e: unknown) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.status).toBe(502);
    expect(err.message).not.toContain("html");
  });

  it("raises LlmError when the response has an unexpected shape or isn't JSON", async () => {
    const weird = fakeFetch(() => json({ nope: true }));
    await expect(provider(weird.fetch).complete(request)).rejects.toThrow("unexpected response shape");
    const notJson = fakeFetch(() => new Response("plain text", { status: 200 }));
    await expect(provider(notJson.fetch).complete(request)).rejects.toThrow("unexpected response shape");
  });

  it("raises LlmError on network failure without leaking the key or the prompt", async () => {
    const f = fakeFetch(() => {
      throw new TypeError(`fetch failed for key ${API_KEY} and body ${request.user}`);
    });
    const err = (await provider(f.fetch).complete(request).catch((e: unknown) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toContain("request failed");
    expect(err.message).not.toContain(API_KEY);
    expect(err.message).not.toContain("private code");
  });

  it("never includes the key or the prompt in any error message", async () => {
    const f = fakeFetch(() => json({ error: { type: "authentication_error", message: `bad key ${API_KEY}` } }, 401));
    const err = (await provider(f.fetch).complete(request).catch((e: unknown) => e)) as LlmError;
    expect(err.message).not.toContain(API_KEY);
    expect(err.message).not.toContain("private code");
  });
});
