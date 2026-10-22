export interface LlmRequest {
  /** Instructions that frame the task. */
  system: string;
  /** The content to work on. */
  user: string;
  maxTokens: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
}

/** The only thing the rest of the app knows about an LLM. Swap vendors by implementing this. */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** A failed call to the provider (HTTP error, bad response, network). Never contains the API key. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
