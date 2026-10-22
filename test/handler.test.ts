import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDiff } from "../src/diff/types.js";
import type { GithubClient } from "../src/github.js";
import { handlePullRequest } from "../src/handlers/pullRequest.js";
import { LlmError } from "../src/llm/provider.js";
import type { SummarizeFn, SummaryResult } from "../src/llm/summarize.js";
import { logger } from "../src/logger.js";

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
  summary: { summary: "Adds auditing.", keyChanges: ["Audit log"], risks: [], testingSuggestions: [] },
  usage: { inputTokens: 1200, outputTokens: 300 },
  calls: 1,
  mode: "single",
};

const payload = (overrides: Record<string, unknown> = {}) => ({
  action: "opened",
  number: 7,
  installation: { id: 99 },
  repository: { name: "widgets", owner: { login: "acme" } },
  pull_request: { title: "Fix login", body: "Makes login safer.", user: { login: "octocat" }, base: { sha: "base123" } },
  ...overrides,
});

function makeDeps(configText: string | null = null, codeownersText: string | null = null) {
  return {
    getPullRequestDiff: vi.fn(async () => diff),
    // Path-aware: the config and CODEOWNERS are different files.
    getFileContent: vi.fn<GithubClient["getFileContent"]>(async (_installationId, _owner, _repo, path) => {
      if (path === ".prpilot.yml") return configText;
      if (path === ".github/CODEOWNERS") return codeownersText;
      return null;
    }),
    getFileHistory: vi.fn<GithubClient["getFileHistory"]>(async () => []),
    summarize: vi.fn<SummarizeFn>(async () => summaryResult),
  };
}

function spyOnLogger() {
  return {
    info: vi.spyOn(logger, "info").mockImplementation(() => {}),
    warn: vi.spyOn(logger, "warn").mockImplementation(() => {}),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("handlePullRequest: rule-based scan", () => {
  it("fetches the diff, scans it, and logs the findings", async () => {
    const log = spyOnLogger();
    const deps = makeDeps();
    await handlePullRequest(payload(), deps);

    expect(deps.getPullRequestDiff).toHaveBeenCalledWith(99, "acme", "widgets", 7);
    expect(log.info).toHaveBeenCalledWith(
      "Pull request received",
      expect.objectContaining({
        pr: 7,
        author: "octocat",
        changedFiles: ["src/auth/login.ts"],
        additions: 2,
        deletions: 1,
        flagCount: 1,
      }),
    );
  });

  it("reads .prpilot.yml from the BASE commit, not the PR head", async () => {
    spyOnLogger();
    const deps = makeDeps();
    await handlePullRequest(payload(), deps);
    expect(deps.getFileContent).toHaveBeenCalledWith(99, "acme", "widgets", ".prpilot.yml", "base123");
  });

  it("applies the repo's config", async () => {
    const log = spyOnLogger();
    await handlePullRequest(payload(), makeDeps("ignore:\n  - 'src/auth/**'\n"));
    expect(log.info).toHaveBeenCalledWith("Pull request received", expect.objectContaining({ flagCount: 0 }));
  });

  it("warns and uses defaults when the config is invalid", async () => {
    const log = spyOnLogger();
    await handlePullRequest(payload(), makeDeps("rulez: {}"));
    expect(log.warn).toHaveBeenCalledWith("Invalid review configuration", expect.objectContaining({ repo: "acme/widgets" }));
    expect(log.info).toHaveBeenCalledWith("Pull request received", expect.objectContaining({ flagCount: 1 }));
  });

  it("still scans with defaults when the config can't be read", async () => {
    const log = spyOnLogger();
    const deps = makeDeps();
    deps.getFileContent.mockRejectedValue(new Error("Resource not accessible by integration"));
    await handlePullRequest(payload(), deps);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Could not read"), expect.anything());
    expect(log.info).toHaveBeenCalledWith("Pull request received", expect.objectContaining({ flagCount: 1 }));
  });

  it("ignores actions it doesn't handle", async () => {
    spyOnLogger();
    const deps = makeDeps();
    await handlePullRequest(payload({ action: "labeled" }), deps);
    expect(deps.getPullRequestDiff).toHaveBeenCalledTimes(0);
    expect(deps.summarize).toHaveBeenCalledTimes(0);
  });

  it("warns and stops on a malformed payload", async () => {
    const log = spyOnLogger();
    const deps = makeDeps();
    await handlePullRequest({ action: "opened" }, deps);
    expect(log.warn).toHaveBeenCalledWith("Unexpected pull_request payload shape", expect.anything());
    expect(deps.getPullRequestDiff).toHaveBeenCalledTimes(0);
  });

  it("warns and stops when there is no installation id", async () => {
    const log = spyOnLogger();
    const deps = makeDeps();
    await handlePullRequest(payload({ installation: undefined }), deps);
    expect(log.warn).toHaveBeenCalledWith("pull_request event had no installation id", expect.anything());
    expect(deps.getPullRequestDiff).toHaveBeenCalledTimes(0);
  });

  it("lets API failures propagate so the server's catch-all can log them", async () => {
    spyOnLogger();
    const deps = makeDeps();
    deps.getPullRequestDiff.mockRejectedValue(new Error("rate limited"));
    await expect(handlePullRequest(payload(), deps)).rejects.toThrow("rate limited");
  });
});

describe("handlePullRequest: LLM summary", () => {
  it("passes the PR text, diff and rule-based flags to the summarizer, then logs usage", async () => {
    const log = spyOnLogger();
    const deps = makeDeps();
    await handlePullRequest(payload(), deps);

    expect(deps.summarize).toHaveBeenCalledTimes(1);
    const arg = deps.summarize.mock.calls[0]![0];
    expect(arg.title).toBe("Fix login");
    expect(arg.body).toBe("Makes login safer.");
    expect(arg.diff).toBe(diff);
    expect(arg.flags.map((f) => f.rule)).toEqual(["sensitivePaths"]); // rules ran BEFORE the LLM

    expect(log.info).toHaveBeenCalledWith(
      "LLM summary",
      expect.objectContaining({ pr: 7, mode: "single", calls: 1, inputTokens: 1200, outputTokens: 300 }),
    );
  });

  it("accepts a PR with no description", async () => {
    spyOnLogger();
    const deps = makeDeps();
    const pr = { title: "t", body: null, user: { login: "o" }, base: { sha: "b" } };
    await handlePullRequest(payload({ pull_request: pr }), deps);
    expect(deps.summarize).toHaveBeenCalledTimes(1);
  });

  it("skips the LLM step when no summarizer is configured", async () => {
    const log = spyOnLogger();
    const full = makeDeps();
    const deps = {
      getPullRequestDiff: full.getPullRequestDiff,
      getFileContent: full.getFileContent,
      getFileHistory: full.getFileHistory,
    };
    await handlePullRequest(payload(), deps);
    expect(log.info).toHaveBeenCalledWith("Pull request received", expect.anything());
    expect(log.info).not.toHaveBeenCalledWith("LLM summary", expect.anything());
  });

  it("logs a warning and keeps the rule-based result when the LLM fails", async () => {
    const log = spyOnLogger();
    const deps = makeDeps();
    deps.summarize.mockRejectedValue(new LlmError("Anthropic API error (HTTP 529, overloaded_error)", 529));
    await handlePullRequest(payload(), deps); // must not throw

    expect(log.info).toHaveBeenCalledWith("Pull request received", expect.objectContaining({ flagCount: 1 }));
    expect(log.warn).toHaveBeenCalledWith(
      "LLM summary failed; continuing with rule-based findings only",
      expect.objectContaining({ pr: 7, error: expect.stringContaining("529") }),
    );
    expect(log.info).not.toHaveBeenCalledWith("LLM summary", expect.anything());
  });
});

describe("handlePullRequest: reviewer suggestions", () => {
  it("reads CODEOWNERS from the base commit and logs the suggested reviewers", async () => {
    const log = spyOnLogger();
    const deps = makeDeps(null, "* @alice @octocat\n");
    await handlePullRequest(payload(), deps);

    expect(deps.getFileContent).toHaveBeenCalledWith(99, "acme", "widgets", ".github/CODEOWNERS", "base123");
    expect(log.info).toHaveBeenCalledWith(
      "Reviewer suggestions",
      expect.objectContaining({
        pr: 7,
        codeowners: ".github/CODEOWNERS",
        // octocat is the PR author, so only alice is suggested
        reviewers: [expect.objectContaining({ handle: "alice", kind: "user", ownedFiles: 1 })],
      }),
    );
  });

  it("looks up file history as of the base commit", async () => {
    spyOnLogger();
    const deps = makeDeps();
    await handlePullRequest(payload(), deps);
    expect(deps.getFileHistory).toHaveBeenCalledWith(99, "acme", "widgets", "src/auth/login.ts", "base123", expect.anything());
  });

  it("suggests recent committers when the repo has no CODEOWNERS", async () => {
    const log = spyOnLogger();
    const deps = makeDeps();
    deps.getFileHistory.mockResolvedValue([{ authorLogin: "bob", authorIsBot: false, date: new Date().toISOString() }]);
    await handlePullRequest(payload(), deps);
    expect(log.info).toHaveBeenCalledWith(
      "Reviewer suggestions",
      expect.objectContaining({ codeowners: null, reviewers: [expect.objectContaining({ handle: "bob" })] }),
    );
  });

  it("keeps going, and still produces the LLM summary, when history lookups fail", async () => {
    const log = spyOnLogger();
    const deps = makeDeps();
    deps.getFileHistory.mockRejectedValue(new Error("502 Bad Gateway"));
    await handlePullRequest(payload(), deps);

    expect(log.info).toHaveBeenCalledWith("Reviewer suggestions", expect.objectContaining({ historyFailures: 1, reviewers: [] }));
    expect(log.info).toHaveBeenCalledWith("LLM summary", expect.anything());
  });

  it("still suggests reviewers when the LLM step fails", async () => {
    const log = spyOnLogger();
    const deps = makeDeps(null, "* @alice\n");
    deps.summarize.mockRejectedValue(new Error("down"));
    await handlePullRequest(payload(), deps);
    expect(log.info).toHaveBeenCalledWith("Reviewer suggestions", expect.objectContaining({ reviewers: [expect.anything()] }));
  });
});
