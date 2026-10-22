import type { ChangedFile } from "../../diff/types.js";
import type { PathRuleConfig } from "../config.js";
import { firstMatch } from "../glob.js";
import type { RiskFlag } from "../types.js";

export function scanDeletedTests(files: ChangedFile[], config: PathRuleConfig): RiskFlag[] {
  return files
    .filter((file) => file.status === "removed" && firstMatch(config.patterns, file.path))
    .map((file) => ({
      rule: "deletedTests" as const,
      severity: config.severity,
      file: file.path,
      reason: "Test file deleted",
    }));
}
