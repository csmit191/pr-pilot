import { describe, expect, it, vi } from "vitest";
import type { ChangedFile } from "../src/diff/types.js";
import type { GithubClient } from "../src/github.js";
import type { CommitInfo } from "../src/reviewers/history.js";
import { MAX_HISTORY_FILES, suggestReviewers, type SuggestContext } from "../src/reviewers/suggest.js";
import { makeFile } from "./helpers.js";

const NOW = new Date("2026-10-22T12:00:00Z");
const commit = (login: string | null, days = 0, isBot = false): CommitInfo => ({
  authorLogin: login,
  authorIsBot: isBot,
  date: new Date(NOW.getTime() - days * 86_400_000).toISOString(),
});

interface FakeGithub {
  files?: Record<string, string | Error>;
  history?: Record<string, CommitInfo[] | Error>;
}

function makeDeps({ files = {}, history = {} }: FakeGithub = {}) {
  return {
    getFileContent: vi.fn<GithubClient["getFileContent"]>(async (_installationId, _owner, _repo, path) => {
      const value = files[path];
      if (value instanceof Error) throw value;
      return value ?? null;
    }),
    getFileHistory: vi.fn<GithubClient["getFileHistory"]>(async (_installationId, _owner, _repo, path) => {
      const value = history[path];
      if (value instanceof Error) throw value;
      return value ?? [];
    }),
  };
}

const ctx = (files: ChangedFile[], author = "octocat"): SuggestContext => ({
  installationId: 99,
  owner: "acme",
  repo: "widgets",
  baseSha: "base123",
  author,
  files,
});
const modified = (path: string, additions = 1) => makeFile({ path, additions });
const run = (files: ChangedFile[], deps: ReturnType<typeof makeDeps>, options = {}) =>
  suggestReviewers(ctx(files), deps, { now: NOW, ...options });
const queriedPaths = (deps: ReturnType<typeof makeDeps>) => deps.getFileHistory.mock.calls.map((c) => c[3]);

describe("suggestReviewers: CODEOWNERS lookup", () => {
  it("tries .github/, root, then docs/, reading from the base commit, and stops at the first hit", async () => {
    const deps = makeDeps({ files: { CODEOWNERS: "* @alice" } });
    const outcome = await run([modified("a.ts")], deps);

    expect(deps.getFileContent.mock.calls.map((c) => c[3])).toEqual([".github/CODEOWNERS", "CODEOWNERS"]);
    expect(deps.getFileContent).toHaveBeenCalledWith(99, "acme", "widgets", "CODEOWNERS", "base123");
    expect(outcome.codeownersPath).toBe("CODEOWNERS");
    expect(outcome.reviewers.map((r) => r.handle)).toEqual(["alice"]);
  });

  it("prefers .github/CODEOWNERS when several exist, like GitHub", async () => {
    const deps = makeDeps({ files: { ".github/CODEOWNERS": "* @first", CODEOWNERS: "* @second" } });
    const outcome = await run([modified("a.ts")], deps);
    expect(outcome.codeownersPath).toBe(".github/CODEOWNERS");
    expect(outcome.reviewers.map((r) => r.handle)).toEqual(["first"]);
    expect(deps.getFileContent).toHaveBeenCalledTimes(1);
  });

  it("falls back to recent committers when the repo has no CODEOWNERS", async () => {
    const deps = makeDeps({ history: { "a.ts": [commit("alice", 3)] } });
    const outcome = await run([modified("a.ts")], deps);
    expect(deps.getFileContent).toHaveBeenCalledTimes(3);
    expect(outcome.codeownersPath).toBeNull();
    expect(outcome.reviewers.map((r) => r.handle)).toEqual(["alice"]);
  });

  it("treats an unreadable location like a missing one and tries the next", async () => {
    const deps = makeDeps({ files: { ".github/CODEOWNERS": new Error("403"), CODEOWNERS: "* @alice" } });
    const outcome = await run([modified("a.ts")], deps);
    expect(outcome.codeownersPath).toBe("CODEOWNERS");
  });

  it("copes with a CODEOWNERS file that has no valid rules", async () => {
    const deps = makeDeps({ files: { ".github/CODEOWNERS": "# nothing yet\n" }, history: { "a.ts": [commit("alice")] } });
    const outcome = await run([modified("a.ts")], deps);
    expect(outcome.codeownersPath).toBe(".github/CODEOWNERS");
    expect(outcome.reviewers.map((r) => r.handle)).toEqual(["alice"]);
  });
});

describe("suggestReviewers: choosing which files to look up", () => {
  it("skips added files and lockfiles (no useful history), but includes removed files", async () => {
    const deps = makeDeps();
    const files = [
      makeFile({ path: "new.ts", status: "added", additions: 50 }),
      modified("package-lock.json", 9000),
      makeFile({ path: "gone.ts", status: "removed", deletions: 5 }),
      modified("kept.ts"),
    ];
    const outcome = await run(files, deps);
    expect(queriedPaths(deps).sort()).toEqual(["gone.ts", "kept.ts"]);
    expect(outcome.historyFilesChecked).toBe(2);
  });

  it("looks up only the most-changed files when the PR is large", async () => {
    const deps = makeDeps();
    const files = Array.from({ length: 12 }, (_, i) => modified(`f${String(i).padStart(2, "0")}.ts`, i + 1));
    const outcome = await run(files, deps);
    expect(outcome.historyFilesChecked).toBe(MAX_HISTORY_FILES);
    expect(queriedPaths(deps).sort()).toEqual(["f04.ts", "f05.ts", "f06.ts", "f07.ts", "f08.ts", "f09.ts", "f10.ts", "f11.ts"]);
  });

  it("honors a custom file limit", async () => {
    const deps = makeDeps();
    await run([modified("a.ts", 1), modified("b.ts", 5), modified("c.ts", 3)], deps, { maxHistoryFiles: 2 });
    expect(queriedPaths(deps).sort()).toEqual(["b.ts", "c.ts"]);
  });

  it("asks for history as of the base commit, limited to the last 365 days", async () => {
    const deps = makeDeps();
    await run([modified("a.ts")], deps);
    expect(deps.getFileHistory).toHaveBeenCalledWith(99, "acme", "widgets", "a.ts", "base123", "2025-10-22T12:00:00.000Z");
  });

  it("queries a renamed file's OLD path, and credits the commits to the new path", async () => {
    const renamed = makeFile({ path: "new/name.ts", previousPath: "old/name.ts", status: "renamed", additions: 2 });
    const deps = makeDeps({ history: { "old/name.ts": [commit("alice", 5)] } });
    const outcome = await run([renamed], deps);
    expect(queriedPaths(deps)).toEqual(["old/name.ts"]);
    expect(outcome.reviewers.map((r) => r.handle)).toEqual(["alice"]);
  });
});

describe("suggestReviewers: resilience", () => {
  it("survives a failed history lookup and counts it", async () => {
    const deps = makeDeps({ history: { "bad.ts": new Error("502"), "good.ts": [commit("alice")] } });
    const outcome = await run([modified("bad.ts"), modified("good.ts")], deps);
    expect(outcome.historyFailures).toBe(1);
    expect(outcome.reviewers.map((r) => r.handle)).toEqual(["alice"]);
  });

  it("returns an empty list, not an error, when everything fails", async () => {
    const boom = new Error("GitHub is down");
    const deps = makeDeps({
      files: { ".github/CODEOWNERS": boom, CODEOWNERS: boom, "docs/CODEOWNERS": boom },
      history: { "a.ts": boom, "b.ts": boom },
    });
    const outcome = await run([modified("a.ts"), modified("b.ts")], deps);
    expect(outcome).toEqual({ reviewers: [], codeownersPath: null, historyFilesChecked: 2, historyFailures: 2 });
  });

  it("returns nothing for a PR with no files", async () => {
    const outcome = await run([], makeDeps());
    expect(outcome.reviewers).toEqual([]);
    expect(outcome.historyFilesChecked).toBe(0);
  });
});

describe("suggestReviewers: end to end", () => {
  it("ranks owners first, then recent committers, excluding the author and bots", async () => {
    const deps = makeDeps({
      files: { ".github/CODEOWNERS": "* @acme/everyone\n/src/auth/ @security-dev\n" },
      history: {
        "src/auth/login.ts": [commit("octocat", 1), commit("dependabot[bot]", 1, true), commit("alice", 2), commit("bob", 40)],
        "src/util.ts": [commit("alice", 3)],
      },
    });
    const files = [modified("src/auth/login.ts", 10), modified("src/util.ts", 4)];
    const outcome = await run(files, deps);

    expect(outcome.reviewers.map((r) => [r.handle, r.kind])).toEqual([
      ["acme/everyone", "team"], // owns src/util.ts: 100 points. Ties break alphabetically,
      ["security-dev", "user"], //  so it precedes security-dev, who owns the auth file: also 100
      ["alice", "user"], // no ownership, 2 recent files: about 1.9 points
    ]);
    expect(outcome.reviewers[2]?.reasons).toEqual(["recently committed to 2 changed files"]);
  });
});
