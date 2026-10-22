import { describe, expect, it } from "vitest";
import { CONFIG_PATH, DEFAULT_CONFIG, parseRiskConfig } from "../src/risk/config.js";

describe("parseRiskConfig", () => {
  it("uses defaults, without a warning, when the repo has no config", () => {
    const result = parseRiskConfig(null);
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect(result.warning).toBeUndefined();
  });

  it("treats an empty or comment-only file as defaults", () => {
    expect(parseRiskConfig("").config).toEqual(DEFAULT_CONFIG);
    expect(parseRiskConfig("# nothing here yet\n").warning).toBeUndefined();
  });

  it("has the documented default values", () => {
    const { rules } = DEFAULT_CONFIG;
    expect(rules.largeDiff.maxChangedLines).toBe(800);
    expect(rules.largeDiff.maxFiles).toBe(50);
    expect(rules.secrets.entropyThreshold).toBe(4.5);
    expect(rules.secrets.minLength).toBe(32);
    expect(rules.sensitivePaths.severity).toBe("high");
    expect(rules.deletedTests.severity).toBe("medium");
    expect(rules.dependencies.lockfileSeverity).toBe("low");
    expect(DEFAULT_CONFIG.ignore).toEqual([]);
  });

  it("merges a partial config over the defaults", () => {
    const yaml = [
      "version: 1",
      "ignore:",
      "  - 'vendor/**'",
      "rules:",
      "  largeDiff:",
      "    maxChangedLines: 100",
      "  sensitivePaths:",
      "    severity: critical",
      "    patterns:",
      "      - '**/admin/**'",
    ].join("\n");
    const { config, warning } = parseRiskConfig(yaml);

    expect(warning).toBeUndefined();
    expect(config.ignore).toEqual(["vendor/**"]);
    expect(config.rules.largeDiff.maxChangedLines).toBe(100);
    expect(config.rules.largeDiff.maxFiles).toBe(50); // untouched default
    expect(config.rules.sensitivePaths.severity).toBe("critical");
    expect(config.rules.sensitivePaths.patterns).toEqual(["**/admin/**"]); // replaces the list
    expect(config.rules.secrets).toEqual(DEFAULT_CONFIG.rules.secrets);
  });

  it("can disable a rule", () => {
    const { config } = parseRiskConfig("rules:\n  secrets:\n    enabled: false\n");
    expect(config.rules.secrets.enabled).toBe(false);
    expect(config.rules.secrets.minLength).toBe(32);
  });

  it("does not modify the shared defaults when parsing", () => {
    const before = JSON.stringify(DEFAULT_CONFIG);
    parseRiskConfig("rules:\n  largeDiff:\n    maxFiles: 1\n");
    expect(JSON.stringify(DEFAULT_CONFIG)).toBe(before);
  });

  describe("falls back to defaults with a warning", () => {
    const cases: Array<[string, string, string]> = [
      ["malformed YAML", "rules: [unclosed", "not valid YAML"],
      ["an unknown top-level key", "rulez: {}", "rulez"],
      ["an unknown rule name", "rules:\n  secret:\n    enabled: false\n", "secret"],
      ["an unknown setting", "rules:\n  largeDiff:\n    maxLines: 5\n", "maxLines"],
      ["a bad severity", "rules:\n  largeDiff:\n    severity: urgent\n", "rules.largeDiff.severity"],
      ["a wrong type", "rules:\n  largeDiff:\n    maxFiles: many\n", "maxFiles"],
      ["a negative limit", "rules:\n  largeDiff:\n    maxChangedLines: -5\n", "maxChangedLines"],
      ["an unsupported version", "version: 2\n", "version"],
      ["a non-object root", "just a string", "(root)"],
      ["a list root", "- a\n- b\n", "(root)"],
    ];

    it.each(cases)("%s", (_name, yaml, expectedFragment) => {
      const result = parseRiskConfig(yaml);
      expect(result.config).toEqual(DEFAULT_CONFIG);
      expect(result.warning).toContain(CONFIG_PATH);
      expect(result.warning).toContain(expectedFragment);
    });

    it("an oversized file", () => {
      const result = parseRiskConfig("# " + "x".repeat(70_000));
      expect(result.config).toEqual(DEFAULT_CONFIG);
      expect(result.warning).toContain("larger than");
    });
  });
});
