import type { z } from "zod";
import type { PullRequestDiff } from "../diff/types.js";
import type { RiskFlag } from "../risk/types.js";
import { parseModelJson } from "./json.js";
import {
  FILE_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  prioritizeFiles,
  renderFileSummaries,
  renderPullRequest,
  renderSingleFile,
  toPromptFiles,
  type FileSummaryEntry,
} from "./prompt.js";
import { LlmError, type LlmProvider, type LlmUsage } from "./provider.js";
import { fileSummarySchema, reviewSummarySchema, type ReviewSummary } from "./schema.js";

export interface SummarizeInput {
  title: string;
  body?: string | null;
  diff: PullRequestDiff;
  flags: RiskFlag[];
}

export interface SummarizeOptions {
  /** Above this many prompt characters (about 4 per token) we switch to map-reduce. */
  maxInputChars: number;
  /** Longer patches are cut so one huge file can't crowd out the rest. */
  maxPatchCharsPerFile: number;
  /** Cap on per-file calls, so a 500-file PR can't cost 500 requests. */
  maxFilesToSummarize: number;
  /** Parallel per-file calls. */
  concurrency: number;
}

export const DEFAULT_SUMMARIZE_OPTIONS: SummarizeOptions = {
  maxInputChars: 60_000,
  maxPatchCharsPerFile: 12_000,
  maxFilesToSummarize: 30,
  concurrency: 4,
};

export interface SummaryResult {
  summary: ReviewSummary;
  usage: LlmUsage;
  /** Total requests made to the provider, including retries. */
  calls: number;
  mode: "single" | "map-reduce";
}

export type SummarizeFn = (input: SummarizeInput) => Promise<SummaryResult>;

/** The model answered, but never with valid JSON in the expected shape (even after a retry). */
export class LlmOutputError extends Error {
  constructor(
    message: string,
    readonly usage: LlmUsage,
  ) {
    super(message);
    this.name = "LlmOutputError";
  }
}

const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
});

interface JsonCall<T> {
  system: string;
  user: string;
  maxTokens: number;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
}

/** Calls the model expecting JSON. On invalid output, retries ONCE, telling it what was wrong. */
async function callForJson<T>(
  provider: LlmProvider,
  call: JsonCall<T>,
): Promise<{ data: T; usage: LlmUsage; calls: number }> {
  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let user = call.user;
  let lastError = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await provider.complete({ system: call.system, user, maxTokens: call.maxTokens });
    usage = addUsage(usage, response.usage);

    const parsed = parseModelJson(response.text, call.schema);
    if (parsed.ok) return { data: parsed.data, usage, calls: attempt };

    lastError = parsed.error;
    user = `${call.user}\n\nYour previous reply was rejected. ${lastError}\nReply again with ONLY one valid JSON object that matches the schema.`;
  }
  throw new LlmOutputError(`Model output failed validation after one retry. ${lastError}`, usage);
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping results in input order. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The model may cite a path that isn't in the PR. Don't show invented file names as fact. */
function sanitizeRiskFiles(summary: ReviewSummary, knownPaths: Set<string>): ReviewSummary {
  return {
    ...summary,
    risks: summary.risks.map((risk) =>
      knownPaths.has(risk.file) ? risk : { ...risk, file: "(general)" },
    ),
  };
}

export async function summarizePullRequest(
  input: SummarizeInput,
  provider: LlmProvider,
  overrides: Partial<SummarizeOptions> = {},
): Promise<SummaryResult> {
  const options = { ...DEFAULT_SUMMARIZE_OPTIONS, ...overrides };
  const { title, body, diff, flags } = input;
  const knownPaths = new Set(diff.files.map((f) => f.path));
  const files = toPromptFiles(diff, flags, options.maxPatchCharsPerFile);
  const header = { title, body, flags };

  // --- Single pass: everything fits in one request.
  const fullPrompt = renderPullRequest({ ...header, files, listingTruncated: diff.truncated });
  if (fullPrompt.length <= options.maxInputChars) {
    const result = await callForJson(provider, {
      system: SYSTEM_PROMPT,
      user: fullPrompt,
      maxTokens: 1500,
      schema: reviewSummarySchema,
    });
    return {
      summary: sanitizeRiskFiles(result.data, knownPaths),
      usage: result.usage,
      calls: result.calls,
      mode: "single",
    };
  }

  // --- Map: summarize the most important files individually.
  const ordered = prioritizeFiles(files, flags);
  const toSummarize = ordered.filter((f) => f.hasDiff).slice(0, options.maxFilesToSummarize);
  const summarizedPaths = new Set(toSummarize.map((f) => f.path));
  const omittedPaths = ordered.filter((f) => !summarizedPaths.has(f.path)).map((f) => f.path);

  let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let calls = 0;

  const entries: FileSummaryEntry[] = await mapWithLimit(toSummarize, options.concurrency, async (file) => {
    try {
      const result = await callForJson(provider, {
        system: FILE_SYSTEM_PROMPT,
        user: renderSingleFile({ ...header, file }),
        maxTokens: 500,
        schema: fileSummarySchema,
      });
      usage = addUsage(usage, result.usage);
      calls += result.calls;
      return { path: file.path, result: result.data };
    } catch (err) {
      // One bad file shouldn't sink the whole review. Record the cost and move on.
      if (err instanceof LlmOutputError) {
        usage = addUsage(usage, err.usage);
        calls += 2;
      } else if (err instanceof LlmError) {
        calls += 1;
      } else {
        throw err;
      }
      return { path: file.path, result: null };
    }
  });

  // --- Reduce: combine the per-file summaries into the final briefing.
  const combined = await callForJson(provider, {
    system: SYSTEM_PROMPT,
    user: renderFileSummaries({ ...header, entries, omittedPaths, listingTruncated: diff.truncated }),
    maxTokens: 1500,
    schema: reviewSummarySchema,
  });

  return {
    summary: sanitizeRiskFiles(combined.data, knownPaths),
    usage: addUsage(usage, combined.usage),
    calls: calls + combined.calls,
    mode: "map-reduce",
  };
}
