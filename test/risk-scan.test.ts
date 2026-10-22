import { describe, expect, it } from "vitest";
import type { PullRequestDiff } from "../src/diff/types.js";
import { DEFAULT_CONFIG, parseRiskConfig } from "../src/risk/config.js";
import { scanDiff, sortFlags } from "../src/risk/scan.js";
import type { RiskFlag } from "../src/risk/types.js";
import { addedPatch, makeFile } from "./helpers.js";

const AWS = "AK" + "IA" + "Q2W3E4R5T6Y7U8I9";
const diffOf = (files: PullRequestDiff["files"], truncated = false): PullRequestDiff => ({ files, truncated });
const summary = (flags: RiskFlag[]) => flags.map((f) => [f.rule, f.severity, f.file]);

// A PR that trips several rules at once.
const riskyFiles = () => [
  makeFile({
    path: "src/auth/login.ts",
    additions: 1,
    patch: ["@@ -1,2 +1,3 @@", " import x", " ", `+const k = "${AWS}";`].join("\n"),
  }),
  makeFile({ path: "test/old.test.ts", status: "removed", deletions: 12 }),
  makeFile({ path: "package.json", additions: 1, patch: addedPatch('"left-pad": "^1.3.0"') }),
  makeFile({ path: "db/migrations/002_drop.sql", status: "added", additions: 1, patch: addedPatch("DROP TABLE users;") }),
  makeFile({ path: "README.md", additions: 1, patch: addedPatch("hello") }),
];

describe("scanDiff", () => {
  it("returns nothing for an empty or harmless diff", () => {
    expect(scanDiff(diffOf([]), DEFAULT_CONFIG)).toEqual([]);
    const harmless = makeFile({ path: "README.md", additions: 1, patch: addedPatch("hello") });
    expect(scanDiff(diffOf([harmless]), DEFAULT_CONFIG)).toEqual([]);
  });

  it("combines every rule and sorts by severity, then file", () => {
    const flags = scanDiff(diffOf(riskyFiles()), DEFAULT_CONFIG);
    expect(summary(flags)).toEqual([
      ["secrets", "critical", "src/auth/login.ts"],
      ["migrations", "high", "db/migrations/002_drop.sql"],
      ["sensitivePaths", "high", "src/auth/login.ts"],
      ["dependencies", "medium", "package.json"],
      ["deletedTests", "medium", "test/old.test.ts"],
    ]);
    expect(flags[0]).toMatchObject({ line: 3 });
  });

  it("never puts the secret value into any flag", () => {
    expect(JSON.stringify(scanDiff(diffOf(riskyFiles()), DEFAULT_CONFIG))).not.toContain(AWS);
  });

  it("skips ignored paths for every rule", () => {
    const { config } = parseRiskConfig("ignore:\n  - 'src/auth/**'\n  - 'db/**'\n");
    const flags = scanDiff(diffOf(riskyFiles()), config);
    expect(summary(flags)).toEqual([
      ["dependencies", "medium", "package.json"],
      ["deletedTests", "medium", "test/old.test.ts"],
    ]);
  });

  it("skips disabled rules", () => {
    const yaml = [
      "rules:",
      "  secrets: { enabled: false }",
      "  sensitivePaths: { enabled: false }",
      "  deletedTests: { enabled: false }",
      "  dependencies: { enabled: false }",
      "  migrations: { enabled: false }",
      "  largeDiff: { enabled: false }",
    ].join("\n");
    const { config } = parseRiskConfig(yaml);
    expect(scanDiff(diffOf(riskyFiles()), config)).toEqual([]);
  });

  it("includes the size rule when the PR is large", () => {
    const big = makeFile({ path: "src/big.ts", additions: 2000, patch: addedPatch("x") });
    const flags = scanDiff(diffOf([big]), DEFAULT_CONFIG);
    expect(flags.map((f) => f.rule)).toEqual(["largeDiff"]);
    expect(flags[0]?.file).toBeUndefined();
  });

  it("flags an incomplete file listing", () => {
    const flags = scanDiff(diffOf([], true), DEFAULT_CONFIG);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ rule: "truncatedDiff", severity: "medium" });
  });

  describe("review configuration changes", () => {
    const configFile = makeFile({ path: ".prpilot.yml", additions: 3, patch: addedPatch("a: 1", "b: 2", "c: 3") });

    it("flags a PR that edits .prpilot.yml", () => {
      const flags = scanDiff(diffOf([configFile]), DEFAULT_CONFIG);
      expect(summary(flags)).toEqual([["reviewConfig", "medium", ".prpilot.yml"]]);
      expect(flags[0]?.reason).toContain("after this PR is merged");
    });

    it("cannot be switched off via ignore", () => {
      const { config } = parseRiskConfig("ignore:\n  - '.prpilot.yml'\n");
      expect(scanDiff(diffOf([configFile]), config)).toHaveLength(1);
    });
  });
});

describe("sortFlags", () => {
  const flag = (over: Partial<RiskFlag>): RiskFlag => ({ rule: "secrets", severity: "low", reason: "r", ...over });

  it("orders by severity, then file, then line, with PR-level flags first within a severity", () => {
    const sorted = sortFlags([
      flag({ severity: "low", file: "a.ts" }),
      flag({ severity: "high", file: "b.ts", line: 9 }),
      flag({ severity: "high", file: "b.ts", line: 2 }),
      flag({ severity: "high", file: "a.ts" }),
      flag({ severity: "high" }),
      flag({ severity: "critical", file: "z.ts" }),
    ]);
    expect(sorted.map((f) => [f.severity, f.file, f.line])).toEqual([
      ["critical", "z.ts", undefined],
      ["high", undefined, undefined],
      ["high", "a.ts", undefined],
      ["high", "b.ts", 2],
      ["high", "b.ts", 9],
      ["low", "a.ts", undefined],
    ]);
  });

  it("does not mutate its input", () => {
    const input = [flag({ severity: "low" }), flag({ severity: "critical" })];
    sortFlags(input);
    expect(input.map((f) => f.severity)).toEqual(["low", "critical"]);
  });
});
