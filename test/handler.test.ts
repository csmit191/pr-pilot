import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDiff } from "../src/diff/types.js";
import { handlePullRequest } from "../src/handlers/pullRequest.js";
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

const payload = (overrides: Record<string, unknown> = {}) => ({
  action: "opened",
  number: 7,
  installation: { id: 99 },
  repository: { name: "widgets", owner: { login: "acme" } },
  pull_request: { user: { login: "octocat" }, base: { sha: "base123" } },
  ...overrides,
});

function makeDeps(configText: string | null = null) {
  return {
    getPullRequestDiff: vi.fn(async () => diff),
    getFileContent: vi.fn(async () => configText),
  };
}

function spyOnLogger() {
  return {
    info: vi.spyOn(logger, "info").mockImplementation(() => {}),
    warn: vi.spyOn(logger, "warn").mockImplementation(() => {}),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("handlePullRequest", () => {
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
