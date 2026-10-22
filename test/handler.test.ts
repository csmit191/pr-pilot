import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDiff } from "../src/diff/types.js";
import type { GithubClient } from "../src/github.js";
import { MARKER } from "../src/comment/render.js";
import { handlePullRequest } from "../src/handlers/pullRequest.js";
import { LlmError } from "../src/llm/provider.js";
import type { SummarizeFn, SummaryResult } from "../src/llm/summarize.js";
import { logger } from "../src/logger.js";
import { createLatestWinsQueue } from "../src/util/latestWins.js";

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

const HEAD_SHA = "aaaaaaa0123456789aaaaaaa0123456789aaaaaa";

const payload = (overrides: Record<string, unknown> = {}) => ({
  action: "opened",
  number: 7,
  installation: { id: 99 },
  repository: { name: "widgets", owner: { login: "acme" } },
  pull_request: {
    title: "Fix login",
    body: "Makes login safer.",
    user: { login: "octocat" },
    base: { sha: "base123" },
    head: { sha: HEAD_SHA },
  },
  ...overrides,
});

const payloadWithHead = (sha: string) =>
  payload({
    pull_request: {
      title: "Fix login",
      body: "Makes login safer.",
      user: { login: "octocat" },
      base: { sha: "base123" },
      head: { sha },
    },
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
    listIssueCommentsPage: vi.fn<GithubClient["listIssueCommentsPage"]>(async () => []),
    createIssueComment: vi.fn<GithubClient["createIssueComment"]>(async () => 555),
    updateIssueComment: vi.fn<GithubClient["updateIssueComment"]>(async () => undefined),
    appId: 123,
    queue: createLatestWinsQueue(), // fresh per test, so tests can't affect each other
  };
}

function spyOnLogger() {
  return {
    info: vi.spyOn(logger, "info").mockImplementation(() => {}),
    warn: vi.spyOn(logger, "warn").mockImplementation(() => {}),
    error: vi.spyOn(logger, "error").mockImplementation(() => {}),
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
    const pr = { title: "t", body: null, user: { login: "o" }, base: { sha: "b" }, head: { sha: "c" } };
    await handlePullRequest(payload({ pull_request: pr }), deps);
    expect(deps.summarize).toHaveBeenCalledTimes(1);
  });

  it("skips the LLM step when no summarizer is configured", async () => {
    const log = spyOnLogger();
    const deps = { ...makeDeps(), summarize: undefined };
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

describe("handlePullRequest: the review comment", () => {
  const postedBody = (deps: ReturnType<typeof makeDeps>) => deps.createIssueComment.mock.calls[0]![4];

  it("posts one comment with the marker, the checks, the summary and the reviewers", async () => {
    const log = spyOnLogger();
    const deps = makeDeps(null, "* @alice\n");
    await handlePullRequest(payload(), deps);

    expect(deps.createIssueComment).toHaveBeenCalledTimes(1);
    expect(deps.createIssueComment).toHaveBeenCalledWith(99, "acme", "widgets", 7, expect.anything());
    const body = postedBody(deps);
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("Adds auditing."); // AI summary
    expect(body).toContain("`src/auth/login.ts`"); // rule-based finding
    expect(body).toContain("`@alice`"); // reviewer
    expect(body).toContain("Reviewed commit `aaaaaaa`");
    expect(log.info).toHaveBeenCalledWith("Review comment posted", expect.objectContaining({ pr: 7, action: "created", commentId: 555 }));
  });

  it("edits the existing comment on later pushes instead of posting another", async () => {
    const log = spyOnLogger();
    const deps = makeDeps();
    deps.listIssueCommentsPage.mockResolvedValue([{ id: 42, body: `${MARKER}\nstale review`, appId: 123 }]);
    await handlePullRequest(payload(), deps);

    expect(deps.updateIssueComment).toHaveBeenCalledWith(99, "acme", "widgets", 42, expect.stringContaining(MARKER));
    expect(deps.createIssueComment).toHaveBeenCalledTimes(0);
    expect(log.info).toHaveBeenCalledWith("Review comment posted", expect.objectContaining({ action: "updated", commentId: 42 }));
  });

  it("does not touch the comment when the review is identical to what is already posted", async () => {
    const log = spyOnLogger();
    const first = makeDeps();
    await handlePullRequest(payload(), first);

    const second = makeDeps();
    second.listIssueCommentsPage.mockResolvedValue([{ id: 7, body: postedBody(first), appId: 123 }]);
    await handlePullRequest(payload(), second);

    expect(second.updateIssueComment).toHaveBeenCalledTimes(0);
    expect(second.createIssueComment).toHaveBeenCalledTimes(0);
    expect(log.info).toHaveBeenCalledWith("Review comment posted", expect.objectContaining({ action: "unchanged" }));
  });

  it("ignores a lookalike comment from another account and posts its own", async () => {
    spyOnLogger();
    const deps = makeDeps();
    deps.listIssueCommentsPage.mockResolvedValue([{ id: 9, body: `${MARKER}\nforged`, appId: null }]);
    await handlePullRequest(payload(), deps);
    expect(deps.createIssueComment).toHaveBeenCalledTimes(1);
    expect(deps.updateIssueComment).toHaveBeenCalledTimes(0);
  });

  it("still posts the rule-based flags and reviewers when the LLM fails", async () => {
    spyOnLogger();
    const deps = makeDeps(null, "* @alice\n");
    deps.summarize.mockRejectedValue(new Error("Anthropic API error (HTTP 529)"));
    await handlePullRequest(payload(), deps);

    const body = postedBody(deps);
    expect(body).toContain("AI summary was unavailable");
    expect(body).toContain("`src/auth/login.ts`");
    expect(body).toContain("`@alice`");
    expect(body).not.toContain("529");
  });

  it("posts a rule-based-only comment when no LLM is configured", async () => {
    spyOnLogger();
    const deps = { ...makeDeps(), summarize: undefined };
    await handlePullRequest(payload(), deps);
    const body = deps.createIssueComment.mock.calls[0]![4];
    expect(body).toContain("Automated checks");
    expect(body).not.toContain("AI summary was unavailable");
    expect(body).not.toContain("### Summary");
  });

  it("shows an invalid .prpilot.yml warning in the comment", async () => {
    spyOnLogger();
    const deps = makeDeps("rulez: {}");
    await handlePullRequest(payload(), deps);
    expect(postedBody(deps)).toContain("[!WARNING]");
  });

  it("logs a helpful error, without throwing, when GitHub refuses the comment (missing permission)", async () => {
    const log = spyOnLogger();
    const deps = makeDeps();
    deps.createIssueComment.mockRejectedValue(Object.assign(new Error("Resource not accessible by integration"), { status: 403 }));
    await handlePullRequest(payload(), deps); // must resolve

    expect(log.error).toHaveBeenCalledWith(
      "Failed to post review comment",
      expect.objectContaining({ pr: 7, status: 403, hint: expect.stringContaining("Pull requests: Read & write") }),
    );
  });

  it("logs other posting failures without a permission hint", async () => {
    const log = spyOnLogger();
    const deps = makeDeps();
    deps.createIssueComment.mockRejectedValue(Object.assign(new Error("Bad gateway"), { status: 502 }));
    await handlePullRequest(payload(), deps);
    expect(log.error).toHaveBeenCalledWith("Failed to post review comment", expect.objectContaining({ status: 502, hint: undefined }));
  });
});

describe("handlePullRequest: quick successive pushes", () => {
  it("reviews and posts only once when a newer push arrives before the older review starts", async () => {
    const log = spyOnLogger();
    const deps = makeDeps();
    const older = handlePullRequest(payloadWithHead("1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), deps);
    const newer = handlePullRequest(payloadWithHead("2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), deps);
    await Promise.all([older, newer]);

    expect(deps.getPullRequestDiff).toHaveBeenCalledTimes(1);
    expect(deps.createIssueComment).toHaveBeenCalledTimes(1);
    expect(deps.createIssueComment.mock.calls[0]![4]).toContain("Reviewed commit `2222222`");
    expect(log.info).toHaveBeenCalledWith("Skipped review: superseded by a newer push", expect.anything());
  });

  it("does not post a stale review when a newer push arrives while the older one is being reviewed", async () => {
    const log = spyOnLogger();
    const deps = makeDeps();

    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    deps.getPullRequestDiff.mockImplementationOnce(async () => {
      started();
      await gate; // the older review is "slow"
      return diff;
    });

    const older = handlePullRequest(payloadWithHead("1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), deps);
    await hasStarted;
    const newer = handlePullRequest(payloadWithHead("2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), deps);
    release();
    await Promise.all([older, newer]);

    expect(deps.getPullRequestDiff).toHaveBeenCalledTimes(2); // both reviewed...
    expect(deps.createIssueComment).toHaveBeenCalledTimes(1); // ...but only the newest posted
    expect(deps.createIssueComment.mock.calls[0]![4]).toContain("Reviewed commit `2222222`");
    expect(log.info).toHaveBeenCalledWith("Not posting: a newer push is already being reviewed", expect.anything());
  });

  it("does not make different pull requests wait for each other", async () => {
    spyOnLogger();
    const deps = makeDeps();
    await Promise.all([
      handlePullRequest(payload({ number: 1 }), deps),
      handlePullRequest(payload({ number: 2 }), deps),
    ]);
    expect(deps.createIssueComment).toHaveBeenCalledTimes(2);
  });
});
