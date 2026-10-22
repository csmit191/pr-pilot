import { describe, expect, it } from "vitest";
import { addedLines } from "../src/risk/patch.js";

describe("addedLines", () => {
  it("returns added lines with new-file line numbers", () => {
    const patch = ["@@ -0,0 +1,2 @@", "+first", "+second"].join("\n");
    expect(addedLines(patch)).toEqual([
      { line: 1, text: "first" },
      { line: 2, text: "second" },
    ]);
  });

  it("counts context lines but not removed lines when numbering", () => {
    const patch = [
      "@@ -10,4 +10,4 @@ function demo() {",
      " context a", // new line 10
      "-old line", //  not in new file
      "+new line", //  new line 11
      " context b", // new line 12
      "+tail", //      new line 13
    ].join("\n");
    expect(addedLines(patch)).toEqual([
      { line: 11, text: "new line" },
      { line: 13, text: "tail" },
    ]);
  });

  it("resets numbering at each hunk header", () => {
    const patch = [
      "@@ -1,1 +1,2 @@",
      " keep",
      "+one",
      "@@ -40,1 +41,2 @@",
      " keep",
      "+two",
    ].join("\n");
    expect(addedLines(patch).map((l) => l.line)).toEqual([2, 42]);
  });

  it("handles hunk headers without a count (single-line hunks)", () => {
    expect(addedLines("@@ -1 +1 @@\n-a\n+b")).toEqual([{ line: 1, text: "b" }]);
  });

  it("ignores the 'No newline at end of file' marker", () => {
    const patch = ["@@ -1,1 +1,2 @@", " keep", "+added", "\\ No newline at end of file", "+later"].join("\n");
    expect(addedLines(patch).map((l) => l.line)).toEqual([2, 3]);
  });

  it("keeps an added line whose content starts with '++'", () => {
    expect(addedLines("@@ -0,0 +1 @@\n+++ not a header")).toEqual([
      { line: 1, text: "++ not a header" },
    ]);
  });

  it("ignores text before the first hunk and returns nothing for an empty patch", () => {
    expect(addedLines("+stray line before any hunk")).toEqual([]);
    expect(addedLines("")).toEqual([]);
  });
});
