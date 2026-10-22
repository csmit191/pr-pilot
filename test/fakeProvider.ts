import type { LlmProvider, LlmRequest } from "../src/llm/provider.js";

export type Responder = (request: LlmRequest, callNumber: number) => string | Promise<string>;

/** A provider that answers from a function and records every request it receives. */
export function fakeProvider(
  respond: Responder,
  usage = { inputTokens: 100, outputTokens: 20 },
): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    name: "fake",
    model: "fake-1",
    requests,
    async complete(request) {
      requests.push(request);
      const text = await respond(request, requests.length);
      return { text, usage };
    },
  };
}

/** Replies in order; a call beyond the list fails the test loudly. */
export const queue =
  (...replies: string[]): Responder =>
  (_request, callNumber) => {
    const reply = replies[callNumber - 1];
    if (reply === undefined) throw new Error(`unexpected LLM call #${callNumber}`);
    return reply;
  };

export const validReview = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    summary: "Adds audit logging to the login flow.",
    keyChanges: ["Writes an audit entry on every login"],
    risks: [],
    testingSuggestions: ["Verify a failed login is also audited"],
    ...overrides,
  });

export const validFileSummary = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ summary: "Changes the module.", risks: [], ...overrides });
