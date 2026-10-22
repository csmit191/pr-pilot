import type { ChangedFile } from "../../diff/types.js";
import type { PathRuleConfig } from "../config.js";
import { firstMatch } from "../glob.js";
import { addedLines } from "../patch.js";
import type { RiskFlag } from "../types.js";

// Raw SQL plus common ORM spellings (knex dropTable, rails remove_column, ...).
const DESTRUCTIVE =
  /\b(?:DROP\s+(?:TABLE|COLUMN|DATABASE|SCHEMA|INDEX)|TRUNCATE|DELETE\s+FROM|drop_?table|drop_?column|remove_?column)\b/i;

export function scanMigrations(files: ChangedFile[], config: PathRuleConfig): RiskFlag[] {
  const flags: RiskFlag[] = [];
  for (const file of files) {
    if (!firstMatch(config.patterns, file.path)) continue;

    if (file.status === "removed") {
      flags.push({
        rule: "migrations",
        severity: "high",
        file: file.path,
        reason: "Migration file deleted; environments that already ran it can drift out of sync",
      });
      continue;
    }

    const destructive =
      file.patch !== null && addedLines(file.patch).some(({ text }) => DESTRUCTIVE.test(text));
    flags.push({
      rule: "migrations",
      severity: destructive ? "high" : config.severity,
      file: file.path,
      reason: destructive
        ? "Database migration contains a destructive operation (DROP/TRUNCATE/DELETE)"
        : "Database migration added or changed",
    });
  }
  return flags;
}
