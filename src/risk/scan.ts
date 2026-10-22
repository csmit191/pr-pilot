import type { PullRequestDiff } from "../diff/types.js";
import { CONFIG_PATH, type RiskConfig } from "./config.js";
import { firstMatch } from "./glob.js";
import { scanDeletedTests } from "./rules/deletedTests.js";
import { scanDependencies } from "./rules/dependencies.js";
import { scanSize } from "./rules/largeDiff.js";
import { scanMigrations } from "./rules/migrations.js";
import { scanSecrets } from "./rules/secrets.js";
import { scanSensitivePaths } from "./rules/sensitivePaths.js";
import { SEVERITY_RANK, type RiskFlag } from "./types.js";

/** Highest severity first, then by file and line so output is stable and testable. */
export function sortFlags(flags: RiskFlag[]): RiskFlag[] {
  return [...flags].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (a.file ?? "").localeCompare(b.file ?? "") ||
      (a.line ?? 0) - (b.line ?? 0),
  );
}

/** Runs every enabled deterministic rule over a PR diff. No network, no LLM. */
export function scanDiff(diff: PullRequestDiff, config: RiskConfig): RiskFlag[] {
  const files = diff.files.filter((file) => !firstMatch(config.ignore, file.path));
  const { rules } = config;
  const flags: RiskFlag[] = [];

  // Not configurable, and checked against ALL files (even ignored ones): changing the
  // review rules deserves a human's attention.
  for (const file of diff.files) {
    if (file.path === CONFIG_PATH) {
      flags.push({
        rule: "reviewConfig",
        severity: "medium",
        file: file.path,
        reason: "Review configuration changed. It takes effect only after this PR is merged",
      });
    }
  }

  if (rules.secrets.enabled) for (const file of files) flags.push(...scanSecrets(file, rules.secrets));
  if (rules.sensitivePaths.enabled) flags.push(...scanSensitivePaths(files, rules.sensitivePaths));
  if (rules.deletedTests.enabled) flags.push(...scanDeletedTests(files, rules.deletedTests));
  if (rules.dependencies.enabled) flags.push(...scanDependencies(files, rules.dependencies));
  if (rules.migrations.enabled) flags.push(...scanMigrations(files, rules.migrations));
  if (rules.largeDiff.enabled) flags.push(...scanSize(files, rules.largeDiff));

  if (diff.truncated) {
    flags.push({
      rule: "truncatedDiff",
      severity: "medium",
      reason: "This PR has more files than GitHub will list (3000); only the first 3000 were reviewed",
    });
  }
  return sortFlags(flags);
}
