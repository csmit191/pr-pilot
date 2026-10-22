import type { ChangedFile } from "../../diff/types.js";
import type { PathRuleConfig } from "../config.js";
import { firstMatch } from "../glob.js";
import type { RiskFlag } from "../types.js";

export function scanSensitivePaths(files: ChangedFile[], config: PathRuleConfig): RiskFlag[] {
  const flags: RiskFlag[] = [];
  for (const file of files) {
    // Also check where a renamed file came from, so moving code out of auth/ still gets noticed.
    const pattern =
      firstMatch(config.patterns, file.path) ??
      (file.previousPath ? firstMatch(config.patterns, file.previousPath) : undefined);
    if (pattern) {
      flags.push({
        rule: "sensitivePaths",
        severity: config.severity,
        file: file.path,
        reason: `Touches security-sensitive code (matches ${pattern})`,
      });
    }
  }
  return flags;
}
