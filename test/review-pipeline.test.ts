import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDiff } from "../src/diff/types.js";
import type { GithubClient } from "../src/github.js";
import { LlmError } from "../src/llm/provider.js";
import { LlmOutputError, type SummarizeFn, type SummaryResult } from "../src/llm/summarize.js";
import { logger } from "../src/logger.js";
import { runReview, type ReviewContext } from "../src/review/pipeline.js";

const diff: PullRequestDiff = {
  files: [
    {
      path: "src/auth/login.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: "@@ -1,2 +1,3 @@\n keep\n-old\n+const a = 1;\n+const b = 2;",
    },
  ],
  truncated: false,
};

const summaryResult: SummaryResult = {
  summary: { summary: "Adds auditing.", keyChanges: [], risks: [], testingSuggestions: [] },
  usage: { inputTokens: 10, outputTokens: 5 },
  calls: 1,
  mode: "single",
};

const ctx: ReviewContext = {
  installationId: 99,
  owner: "acme",
  repo: "widgets",
  number: 7,
  action: "opened",
  title: "Fix login",
  body: "Makes login safer.",
  author: "octocat",
  baseSha: "base123",
};

function makeDeps() {
  return {
    getPullRequestDiff: vi.fn<GithubClient["getPullRequestDiff"]>(async () => diff),
    getFileContent: vi.fn<GithubClient["getFileContent"]>(async () => null),
    getFileHistory: vi.fn<GithubClient["getFileHistory"]>(async () => []),
    summarize: vi.fn<SummarizeFn>(async () => summaryResult),
  };
}

afterEach(() => vi.restoreAllMocks());
const quiet = () => {
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
};

describe("runReview", () => {
  it("returns the diff, rule-based flags, summary and reviewers without posting anything", async () => {
    quiet();
    const deps = makeDeps();
    deps.getFileHistory.mockResolvedValue([{ authorLogin: "bob", authorIsBot: false, date: new Date().toISOString() }]);
    const result = await runReview(ctx, deps);

    expect(result.diff).toBe(diff);
    expect(result.flags.map((f) => f.rule)).toEqual(["sensitivePaths"]);
    expect(result.summary).toEqual({ status: "ok", result: summaryResult });
    expect(result.reviewers?.reviewers.map((r) => r.handle)).toEqual(["bob"]);
    expect(result.configWarning).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("marks the summary as disabled when no summarizer is configured", async () => {
    quiet();
    const deps = { ...makeDeps(), summarize: undefined };
    expect((await runReview(ctx, deps)).summary).toEqual({ status: "disabled" });
  });

  it("reports an LLM failure in the result instead of throwing, keeping the flags", async () => {
    quiet();
    const deps = makeDeps();
    deps.summarize.mockRejectedValue(new LlmError("Anthropic API error (HTTP 529, overloaded_error)", 529));
    const result = await runReview(ctx, deps);
    expect(result.summary).toMatchObject({ status: "failed", error: expect.stringContaining("529") });
    expect(result.flags).toHaveLength(1);
    expect(result.reviewers).not.toBeNull();
  });

  it("reports the tokens a failed summary already spent, so cost isn't under-counted", async () => {
    quiet();
    const deps = makeDeps();
    deps.summarize.mockRejectedValue(new LlmOutputError("Model output failed validation after one retry.", { inputTokens: 200, outputTokens: 40 }));
    const result = await runReview(ctx, deps);
    expect(result.summary).toEqual({
      status: "failed",
      error: expect.stringContaining("failed validation"),
      usage: { inputTokens: 200, outputTokens: 40 },
    });
  });

  it("reports no token usage when the provider itself failed (nothing was generated)", async () => {
    quiet();
    const deps = makeDeps();
    deps.summarize.mockRejectedValue(new LlmError("Anthropic API error (HTTP 500)", 500));
    const result = await runReview(ctx, deps);
    expect((result.summary as { usage?: unknown }).usage).toBeUndefined();
  });

  it("surfaces an invalid .prpilot.yml as a warning and still scans", async () => {
    quiet();
    const deps = makeDeps();
    deps.getFileContent.mockImplementation(async (_i, _o, _r, path) => (path === ".prpilot.yml" ? "rulez: {}" : null));
    const result = await runReview(ctx, deps);
    expect(result.configWarning).toContain("rulez");
    expect(result.flags).toHaveLength(1);
  });

  it("returns reviewers: null if the reviewer lookup fails unexpectedly, and still returns everything else", async () => {
    quiet();
    // A file whose `previousPath` blows up, but only after the CODEOWNERS lookup has started, so the
    // rule-based scan (which also reads it) succeeds and the failure happens inside the reviewer step.
    let armed = false;
    const trapped = {
      ...diff.files[0]!,
      get previousPath(): string | undefined {
        if (armed) throw new Error("unexpected failure while scoring");
        return undefined;
      },
    };
    const deps = makeDeps();
    deps.getPullRequestDiff.mockResolvedValue({ files: [trapped], truncated: false });
    deps.getFileContent.mockImplementation(async (_i, _o, _r, path) => {
      if (path.endsWith("CODEOWNERS")) armed = true;
      return null;
    });

    const result = await runReview(ctx, deps);
    expect(result.reviewers).toBeNull();
    expect(result.summary.status).toBe("ok");
    expect(result.flags).toHaveLength(1);
  });

  it("runs the LLM summary and the reviewer lookup at the same time", async () => {
    quiet();
    const events: string[] = [];
    const deps = makeDeps();
    deps.summarize.mockImplementation(async () => {
      events.push("summary start");
      await new Promise((resolve) => setTimeout(resolve, 15));
      events.push("summary end");
      return summaryResult;
    });
    deps.getFileHistory.mockImplementation(async () => {
      events.push("history");
      return [];
    });
    await runReview(ctx, deps);
    expect(events).toEqual(["summary start", "history", "summary end"]);
  });

  it("propagates a failure to fetch the diff: there is nothing to review without it", async () => {
    quiet();
    const deps = makeDeps();
    deps.getPullRequestDiff.mockRejectedValue(new Error("rate limited"));
    await expect(runReview(ctx, deps)).rejects.toThrow("rate limited");
  });
});
