import type { ChangedFile } from "../../diff/types.js";
import type { LargeDiffRuleConfig } from "../config.js";
import type { RiskFlag } from "../types.js";
import { isLockfile } from "./dependencies.js";

export function scanSize(files: ChangedFile[], config: LargeDiffRuleConfig): RiskFlag[] {
  // Lockfile churn can be thousands of generated lines and says nothing about review effort.
  const counted = files.filter((file) => !isLockfile(file.path));
  const changedLines = counted.reduce((sum, f) => sum + f.additions + f.deletions, 0);

  const flags: RiskFlag[] = [];
  if (changedLines > config.maxChangedLines) {
    flags.push({
      rule: "largeDiff",
      severity: config.severity,
      reason: `Large change: ${changedLines} lines changed (limit ${config.maxChangedLines}); consider splitting this PR`,
    });
  }
  if (counted.length > config.maxFiles) {
    flags.push({
      rule: "largeDiff",
      severity: config.severity,
      reason: `Many files changed: ${counted.length} (limit ${config.maxFiles}); consider splitting this PR`,
    });
  }
  return flags;
}
