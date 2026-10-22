import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDiff } from "../src/diff/types.js";
import type { GithubClient } from "../src/github.js";
import { createRecorder, createReplayDeps } from "../src/eval/snapshot.js";
import { logger } from "../src/logger.js";
import { runReview } from "../src/review/pipeline.js";
import type { CommitInfo } from "../src/reviewers/history.js";

const diff: PullRequestDiff = {
  files: [
    { path: "src/auth/login.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1,2 +1,3 @@\n keep\n-old\n+audit(user);\n+return user;" },
    { path: "test/login.test.ts", status: "removed", additions: 0, deletions: 2, patch: "@@ -1,2 +0,0 @@\n-a\n-b" },
  ],
  truncated: false,
};
const history: CommitInfo[] = [{ authorLogin: "alice", authorIsBot: false, date: "2026-10-01T00:00:00Z" }];

function makeInner(): Pick<GithubClient, "getPullRequestDiff" | "getFileContent" | "getFileHistory"> {
  return {
    getPullRequestDiff: async () => diff,
    getFileContent: async (_i, _o, _r, path) => (path === ".github/CODEOWNERS" ? "* @bob\n" : null),
    getFileHistory: async (_i, _o, _r, path) => (path === "src/auth/login.ts" ? history : []),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("createRecorder", () => {
  it("passes answers through unchanged and remembers them", async () => {
    const recorder = createRecorder(makeInner());
    expect(await recorder.deps.getPullRequestDiff(0, "a", "b", 1)).toBe(diff);
    expect(await recorder.deps.getFileContent(0, "a", "b", ".github/CODEOWNERS", "x")).toBe("* @bob\n");
    expect(await recorder.deps.getFileContent(0, "a", "b", ".prpilot.yml", "x")).toBeNull();
    expect(await recorder.deps.getFileHistory(0, "a", "b", "src/auth/login.ts", "x", "s")).toBe(history);

    expect(recorder.recording()).toEqual({
      diff,
      files: { ".github/CODEOWNERS": "* @bob\n", ".prpilot.yml": null },
      history: { "src/auth/login.ts": history },
    });
  });

  it("reports no diff if none was requested", () => {
    expect(createRecorder(makeInner()).recording().diff).toBeNull();
  });

  it("is safe against a file literally named __proto__", async () => {
    const inner = { ...makeInner(), getFileContent: async () => "owned" };
    const recorder = createRecorder(inner);
    await recorder.deps.getFileContent(0, "a", "b", "__proto__", "x");
    const { files } = recorder.recording();
    expect(Object.hasOwn(files, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(files)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).owned).toBeUndefined();
  });
});

describe("createReplayDeps", () => {
  const replay = createReplayDeps({ diff, files: { ".github/CODEOWNERS": "* @bob\n", ".prpilot.yml": null }, history: { "src/auth/login.ts": history } });

  it("answers from the snapshot, ignoring ids, refs and dates", async () => {
    expect(await replay.getPullRequestDiff(123, "x", "y", 999)).toBe(diff);
    expect(await replay.getFileContent(1, "x", "y", ".github/CODEOWNERS", "any-ref")).toBe("* @bob\n");
    expect(await replay.getFileHistory(1, "x", "y", "src/auth/login.ts", "any-ref", "any-date")).toBe(history);
  });

  it("answers 'missing' for anything that wasn't recorded", async () => {
    expect(await replay.getFileContent(0, "a", "b", ".prpilot.yml", "x")).toBeNull();
    expect(await replay.getFileContent(0, "a", "b", "never-asked", "x")).toBeNull();
    expect(await replay.getFileContent(0, "a", "b", "__proto__", "x")).toBeNull();
    expect(await replay.getFileHistory(0, "a", "b", "never-asked", "x", "s")).toEqual([]);
    expect(await replay.getFileHistory(0, "a", "b", "constructor", "x", "s")).toEqual([]);
  });
});

describe("record then replay", () => {
  it("gives the pipeline exactly the same findings and reviewers as the live run", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const ctx = { installationId: 0, owner: "a", repo: "b", number: 1, action: "eval", title: "t", body: null, author: "octocat", baseSha: "base" };

    const recorder = createRecorder(makeInner());
    const live = await runReview(ctx, recorder.deps);

    const recorded = recorder.recording();
    const replayed = await runReview(ctx, createReplayDeps({ diff: recorded.diff ?? diff, files: recorded.files, history: recorded.history }));

    expect(replayed.flags).toEqual(live.flags);
    expect(replayed.reviewers?.reviewers).toEqual(live.reviewers?.reviewers);
    expect(live.reviewers?.reviewers.map((r) => r.handle)).toEqual(["bob", "alice"]); // CODEOWNERS owner first, then committer
  });
});
