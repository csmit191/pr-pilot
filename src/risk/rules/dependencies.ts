import { posix } from "node:path";
import type { ChangedFile } from "../../diff/types.js";
import type { DependenciesRuleConfig } from "../config.js";
import { LOCKFILE_PATTERNS, MANIFEST_PATTERNS } from "../defaults.js";
import { firstMatch } from "../glob.js";
import type { RiskFlag } from "../types.js";

export const isLockfile = (path: string): boolean => firstMatch(LOCKFILE_PATTERNS, path) !== undefined;

export function scanDependencies(files: ChangedFile[], config: DependenciesRuleConfig): RiskFlag[] {
  const flags: RiskFlag[] = [];
  for (const file of files) {
    const name = posix.basename(file.path);
    if (firstMatch(MANIFEST_PATTERNS, file.path)) {
      flags.push({
        rule: "dependencies",
        severity: config.severity,
        file: file.path,
        reason: `Dependency manifest changed (${name})`,
      });
    } else if (isLockfile(file.path)) {
      flags.push({
        rule: "dependencies",
        severity: config.lockfileSeverity,
        file: file.path,
        reason: `Lockfile changed (${name})`,
      });
    }
  }
  return flags;
}
