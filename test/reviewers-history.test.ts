import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCommitHistory } from "../src/reviewers/history.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/commits-page.json", import.meta.url), "utf8"),
) as unknown;

describe("parseCommitHistory", () => {
  const commits = parseCommitHistory(fixture);

  it("extracts login, bot-ness and date, in order", () => {
    expect(commits).toEqual([
      { authorLogin: "alice", authorIsBot: false, date: "2026-10-01T12:00:00Z" },
      { authorLogin: "dependabot[bot]", authorIsBot: true, date: "2026-09-30T08:00:00Z" },
      { authorLogin: null, authorIsBot: false, date: "2026-09-20T10:00:00Z" },
      { authorLogin: null, authorIsBot: false, date: "2026-09-10T10:00:00Z" },
      { authorLogin: "bob", authorIsBot: false, date: "2026-09-01T00:00:00Z" },
      { authorLogin: "renovate[bot]", authorIsBot: true, date: "2026-08-15T00:00:00Z" },
    ]);
  });

  it("keeps commits whose email isn't linked to an account (author null) or is an empty object", () => {
    expect(commits.filter((c) => c.authorLogin === null)).toHaveLength(2);
  });

  it("falls back to the committer date when there is no author date", () => {
    expect(commits.find((c) => c.authorLogin === "bob")?.date).toBe("2026-09-01T00:00:00Z");
  });

  it("drops commits with no usable date and malformed entries", () => {
    expect(commits.some((c) => c.authorLogin === "carol")).toBe(false);
    expect(commits.some((c) => c.authorLogin === "dave")).toBe(false);
  });

  it("detects bots by login suffix even when GitHub's type says User", () => {
    expect(commits.find((c) => c.authorLogin === "renovate[bot]")?.authorIsBot).toBe(true);
  });

  it("returns an empty list for an empty page and throws for a non-list response", () => {
    expect(parseCommitHistory([])).toEqual([]);
    expect(() => parseCommitHistory({ message: "Not Found" })).toThrow("Unexpected commit list response");
    expect(() => parseCommitHistory(null)).toThrow();
  });
});
