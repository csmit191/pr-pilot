import { describe, expect, it } from "vitest";
import { parseCodeowners } from "../src/reviewers/codeowners.js";
import type { CommitInfo } from "../src/reviewers/history.js";
import { SCORING, scoreReviewers, type ScoreInput } from "../src/reviewers/score.js";
import { makeFile } from "./helpers.js";

const NOW = new Date("2026-10-22T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const commit = (login: string | null, days: number, isBot = false): CommitInfo => ({
  authorLogin: login,
  authorIsBot: isBot,
  date: daysAgo(days),
});
const hist = (entries: Record<string, CommitInfo[]>) => new Map(Object.entries(entries));
const run = (overrides: Partial<ScoreInput> = {}) =>
  scoreReviewers({ author: "octocat", files: [], rules: [], history: new Map(), now: NOW, ...overrides });
const file = (path: string) => makeFile({ path });
const handlesOf = (suggestions: ReturnType<typeof run>) => suggestions.map((s) => s.handle);

describe("scoreReviewers: history", () => {
  it("returns nothing when there is nothing to go on", () => {
    expect(run()).toEqual([]);
    expect(run({ files: [file("a.ts")] })).toEqual([]);
  });

  it("scores one commit made today as 1 point", () => {
    expect(run({ files: [file("a.ts")], history: hist({ "a.ts": [commit("alice", 0)] }) })).toEqual([
      { handle: "alice", kind: "user", score: 1, ownedFiles: 0, recentFiles: 1, reasons: ["recently committed to 1 changed file"] },
    ]);
  });

  it("halves a commit's weight every 90 days", () => {
    const score = (days: number) =>
      run({ files: [file("a.ts")], history: hist({ "a.ts": [commit("alice", days)] }) })[0]?.score;
    expect(score(90)).toBe(0.5);
    expect(score(180)).toBe(0.25);
    expect(score(30)).toBe(0.79);
  });

  it("ranks a recent committer above an old one", () => {
    const result = run({
      files: [file("a.ts")],
      history: hist({ "a.ts": [commit("old-timer", 200), commit("fresh", 10)] }),
    });
    expect(handlesOf(result)).toEqual(["fresh", "old-timer"]);
  });

  it("caps what one person can earn from a single file", () => {
    const five = Array.from({ length: 5 }, () => commit("alice", 0));
    const result = run({ files: [file("a.ts")], history: hist({ "a.ts": five }) });
    expect(result[0]?.score).toBe(SCORING.perFileCap);
  });

  it("prefers breadth over depth: one commit on 3 files beats 5 commits on 1 file", () => {
    const result = run({
      files: [file("a.ts"), file("b.ts"), file("c.ts")],
      history: hist({
        "a.ts": [commit("broad", 0), ...Array.from({ length: 5 }, () => commit("deep", 0))],
        "b.ts": [commit("broad", 0)],
        "c.ts": [commit("broad", 0)],
      }),
    });
    expect(result.map((s) => [s.handle, s.score, s.recentFiles])).toEqual([
      ["broad", 3, 3],
      ["deep", 2, 1],
    ]);
  });

  it("never suggests the PR author (case-insensitively)", () => {
    const result = run({
      author: "OctoCat",
      files: [file("a.ts")],
      history: hist({ "a.ts": [commit("octocat", 0), commit("alice", 0)] }),
    });
    expect(handlesOf(result)).toEqual(["alice"]);
  });

  it("never suggests bots or commits without a GitHub account", () => {
    const result = run({
      files: [file("a.ts")],
      history: hist({
        "a.ts": [
          commit("dependabot[bot]", 0),
          commit("some-app", 0, true),
          commit(null, 0),
          commit("alice", 1),
        ],
      }),
    });
    expect(handlesOf(result)).toEqual(["alice"]);
  });

  it("treats logins case-insensitively and keeps the first spelling it saw", () => {
    const result = run({
      files: [file("a.ts")],
      history: hist({ "a.ts": [commit("Alice", 0), commit("alice", 0)] }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ handle: "Alice", score: 2 });
  });

  it("ignores unparseable dates and treats future dates (clock skew) as 'now'", () => {
    const result = run({
      files: [file("a.ts")],
      history: hist({
        "a.ts": [
          { authorLogin: "garbled", authorIsBot: false, date: "not a date" },
          { authorLogin: "skewed", authorIsBot: false, date: daysAgo(-5) },
        ],
      }),
    });
    expect(result.map((s) => [s.handle, s.score])).toEqual([["skewed", 1]]);
  });

  it("ignores history recorded for paths that aren't in the PR", () => {
    const result = run({ files: [file("a.ts")], history: hist({ "unrelated.ts": [commit("alice", 0)] }) });
    expect(result).toEqual([]);
  });

  it("drops candidates whose commits are so old they round to zero points", () => {
    const result = run({ files: [file("a.ts")], history: hist({ "a.ts": [commit("ancient", 5000)] }) });
    expect(result).toEqual([]);
  });
});

describe("scoreReviewers: CODEOWNERS", () => {
  it("awards 100 points per owned changed file, using the last matching rule", () => {
    const rules = parseCodeowners("* @generalist\n/src/auth/ @security-dev\n");
    const result = run({
      files: [file("src/auth/x.ts"), file("src/auth/y.ts"), file("docs/z.md")],
      rules,
    });
    expect(result).toEqual([
      { handle: "security-dev", kind: "user", score: 200, ownedFiles: 2, recentFiles: 0, reasons: ["owns 2 changed files (CODEOWNERS)"] },
      { handle: "generalist", kind: "user", score: 100, ownedFiles: 1, recentFiles: 0, reasons: ["owns 1 changed file (CODEOWNERS)"] },
    ]);
  });

  it("ownership always outranks even the heaviest possible history", () => {
    const files = Array.from({ length: 8 }, (_, i) => file(`f${i}.ts`));
    const history = hist(Object.fromEntries(files.map((f) => [f.path, [commit("committer", 0), commit("committer", 0), commit("committer", 0)]])));
    const result = run({ files, history, rules: parseCodeowners("/f0.ts @owner\n") });
    expect(result[0]?.handle).toBe("owner");
    expect(result[1]).toMatchObject({ handle: "committer", score: 16 });
    expect(SCORING.ownerPointsPerFile).toBeGreaterThan(SCORING.perFileCap * 8);
  });

  it("adds history on top of ownership and explains both", () => {
    const result = run({
      files: [file("a.ts")],
      rules: parseCodeowners("* @alice"),
      history: hist({ "a.ts": [commit("alice", 0)] }),
    });
    expect(result[0]).toEqual({
      handle: "alice",
      kind: "user",
      score: 101,
      ownedFiles: 1,
      recentFiles: 1,
      reasons: ["owns 1 changed file (CODEOWNERS)", "recently committed to 1 changed file"],
    });
  });

  it("suggests teams, which never get history points", () => {
    const result = run({ files: [file("a.ts")], rules: parseCodeowners("* @acme/platform") });
    expect(result).toEqual([
      { handle: "acme/platform", kind: "team", score: 100, ownedFiles: 1, recentFiles: 0, reasons: ["owns 1 changed file (CODEOWNERS)"] },
    ]);
  });

  it("skips email owners, because they can't be mapped to a GitHub login", () => {
    expect(run({ files: [file("a.ts")], rules: parseCodeowners("* dev@example.com") })).toEqual([]);
  });

  it("never suggests the PR author as an owner, but keeps co-owners", () => {
    const result = run({ files: [file("a.ts")], rules: parseCodeowners("* @octocat @alice") });
    expect(handlesOf(result)).toEqual(["alice"]);
  });

  it("respects an 'unowned' override", () => {
    const rules = parseCodeowners("* @alice\n/src/\n");
    const result = run({ files: [file("src/a.ts"), file("README.md")], rules });
    expect(result[0]).toMatchObject({ handle: "alice", ownedFiles: 1 });
  });

  it("counts a renamed file for the owners of both its old and new location", () => {
    const rules = parseCodeowners("/old/ @olduser\n/new/ @newuser\n");
    const renamed = makeFile({ path: "new/f.ts", previousPath: "old/f.ts", status: "renamed" });
    const result = run({ files: [renamed], rules });
    expect(result.map((s) => [s.handle, s.ownedFiles])).toEqual([
      ["newuser", 1],
      ["olduser", 1],
    ]);
  });

  it("counts a file once per owner even if old and new locations share an owner", () => {
    const renamed = makeFile({ path: "b.ts", previousPath: "a.ts", status: "renamed" });
    const result = run({ files: [renamed], rules: parseCodeowners("* @alice") });
    expect(result[0]?.ownedFiles).toBe(1);
  });

  it("merges an owner and a committer who differ only in letter case", () => {
    const result = run({
      files: [file("a.ts")],
      rules: parseCodeowners("* @Alice"),
      history: hist({ "a.ts": [commit("alice", 0)] }),
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ handle: "Alice", score: 101 });
  });
});

describe("scoreReviewers: limits and ordering", () => {
  const fiveEqual = hist({ "a.ts": ["eve", "carol", "bob", "dave", "alice"].map((n) => commit(n, 0)) });

  it("returns at most 3 by default, breaking ties alphabetically", () => {
    expect(handlesOf(run({ files: [file("a.ts")], history: fiveEqual }))).toEqual(["alice", "bob", "carol"]);
  });

  it("honors a custom maximum", () => {
    expect(handlesOf(run({ files: [file("a.ts")], history: fiveEqual, max: 1 }))).toEqual(["alice"]);
  });
});
