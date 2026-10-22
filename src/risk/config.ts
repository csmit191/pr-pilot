import { parse } from "yaml";
import { z } from "zod";
import {
  DEFAULT_MIGRATION_PATTERNS,
  DEFAULT_SENSITIVE_PATHS,
  DEFAULT_TEST_PATTERNS,
} from "./defaults.js";
import { SEVERITIES, type Severity } from "./types.js";

/** Where the config lives in the target repo. */
export const CONFIG_PATH = ".prpilot.yml";
const MAX_CONFIG_CHARS = 64 * 1024;

const severity = z.enum(SEVERITIES);
const globList = z.array(z.string().min(1));

// .strict() everywhere: a typo like "sensitivePath:" should be reported, not silently ignored.
const pathRule = (defaultSeverity: Severity, defaultPatterns: string[]) =>
  z
    .object({
      enabled: z.boolean().default(true),
      severity: severity.default(defaultSeverity),
      patterns: globList.default(defaultPatterns),
    })
    .strict();

const riskConfigSchema = z
  .object({
    version: z.literal(1).optional(),
    /** Files no rule looks at (vendored code, generated files, docs...). */
    ignore: globList.default([]),
    rules: z
      .object({
        secrets: z
          .object({
            enabled: z.boolean().default(true),
            entropyThreshold: z.number().min(0).max(8).default(4.5),
            minLength: z.number().int().min(8).default(32),
            allowPaths: globList.default([]),
          })
          .strict()
          .default({}),
        sensitivePaths: pathRule("high", DEFAULT_SENSITIVE_PATHS).default({}),
        deletedTests: pathRule("medium", DEFAULT_TEST_PATTERNS).default({}),
        migrations: pathRule("medium", DEFAULT_MIGRATION_PATTERNS).default({}),
        dependencies: z
          .object({
            enabled: z.boolean().default(true),
            severity: severity.default("medium"),
            lockfileSeverity: severity.default("low"),
          })
          .strict()
          .default({}),
        largeDiff: z
          .object({
            enabled: z.boolean().default(true),
            severity: severity.default("medium"),
            maxChangedLines: z.number().int().positive().default(800),
            maxFiles: z.number().int().positive().default(50),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
  })
  .strict();

export type RiskConfig = z.infer<typeof riskConfigSchema>;
export type SecretsRuleConfig = RiskConfig["rules"]["secrets"];
export type PathRuleConfig = RiskConfig["rules"]["sensitivePaths"];
export type DependenciesRuleConfig = RiskConfig["rules"]["dependencies"];
export type LargeDiffRuleConfig = RiskConfig["rules"]["largeDiff"];

export const DEFAULT_CONFIG: RiskConfig = riskConfigSchema.parse({});

export interface ConfigResult {
  config: RiskConfig;
  /** Set when the file existed but couldn't be used; we fell back to defaults. */
  warning?: string;
}

/**
 * Turns the text of .prpilot.yml (or null if the repo has none) into a validated config.
 * Never throws: a broken config must not stop a PR from being reviewed.
 */
export function parseRiskConfig(yamlText: string | null): ConfigResult {
  if (yamlText === null) return { config: DEFAULT_CONFIG };

  if (yamlText.length > MAX_CONFIG_CHARS) {
    return {
      config: DEFAULT_CONFIG,
      warning: `${CONFIG_PATH} is larger than ${MAX_CONFIG_CHARS} characters; using defaults.`,
    };
  }

  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      config: DEFAULT_CONFIG,
      warning: `${CONFIG_PATH} is not valid YAML (${detail}); using defaults.`,
    };
  }

  if (raw === null || raw === undefined) return { config: DEFAULT_CONFIG }; // empty file

  const result = riskConfigSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return {
      config: DEFAULT_CONFIG,
      warning: `${CONFIG_PATH} is invalid (${detail}); using defaults.`,
    };
  }
  return { config: result.data };
}
