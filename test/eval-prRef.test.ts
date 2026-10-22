import { describe, expect, it } from "vitest";
import { parsePrRef, snapshotFileName } from "../src/eval/prRef.js";

describe("parsePrRef", () => {
  const accepted: Array<[string, string, string, number]> = [
    ["expressjs/express#5555", "expressjs", "express", 5555],
    ["  octo-org/my.repo_1#7  ", "octo-org", "my.repo_1", 7],
    ["https://github.com/expressjs/express/pull/5555", "expressjs", "express", 5555],
    ["https://github.com/expressjs/express/pull/5555/files", "expressjs", "express", 5555],
    ["https://github.com/expressjs/express/pull/5555/commits/", "expressjs", "express", 5555],
    ["https://github.com/expressjs/express/pull/5555#issuecomment-1", "expressjs", "express", 5555],
    ["https://github.com/expressjs/express/pull/5555?diff=split", "expressjs", "express", 5555],
  ];

  it.each(accepted)("accepts %s", (text, owner, repo, number) => {
    expect(parsePrRef(text)).toEqual({
      owner,
      repo,
      number,
      id: `${owner}/${repo}#${number}`,
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
    });
  });

  it.each([
    "",
    "express#5555",
    "expressjs/express",
    "expressjs/express#0",
    "expressjs/express#abc",
    "expressjs/express#-3",
    "http://github.com/expressjs/express/pull/5",
    "https://gitlab.com/expressjs/express/pull/5",
    "https://github.com/expressjs/express/issues/5",
    "https://evil.test/https://github.com/a/b/pull/5",
    "a/b#99999999999999999999",
    "owner/repo name#5",
    "../repo#5",
    "owner/..#5",
    "./x#5",
    "a/b/c#5",
  ])("rejects %j", (text) => {
    expect(parsePrRef(text)).toBeNull();
  });
});

describe("snapshotFileName", () => {
  it("is a flat, filesystem-safe name", () => {
    expect(snapshotFileName({ owner: "o", repo: "r.js", number: 12 })).toBe("o__r.js__12.json");
  });
});
