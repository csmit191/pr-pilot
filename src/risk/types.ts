export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export type RuleId =
  | "secrets"
  | "sensitivePaths"
  | "deletedTests"
  | "dependencies"
  | "migrations"
  | "largeDiff"
  | "reviewConfig"
  | "truncatedDiff";

export interface RiskFlag {
  rule: RuleId;
  severity: Severity;
  /** Human-readable explanation. Must NEVER contain the matched secret itself. */
  reason: string;
  /** Absent for PR-level flags (e.g. "diff is large"). */
  file?: string;
  /** 1-indexed line in the NEW version of the file. */
  line?: number;
}
