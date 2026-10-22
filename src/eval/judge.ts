import type { ReviewResult } from "../review/pipeline.js";
import type { DatasetEntry, EvalFinding, EvalLabel, PrJudgment } from "./types.js";

/** Flattens a review into the list of things the tool told the reviewer, each with a stable id. */
export function extractFindings(review: Pick<ReviewResult, "flags" | "summary">): EvalFinding[] {
  const fromRules = review.flags.map(
    (flag, index): EvalFinding => ({
      id: `r${index}`,
      source: "rule",
      rule: flag.rule,
      severity: flag.severity,
      file: flag.file,
      line: flag.line,
      text: flag.reason,
    }),
  );
  const fromLlm =
    review.summary.status === "ok"
      ? review.summary.result.summary.risks.map(
          (risk, index): EvalFinding => ({
            id: `l${index}`,
            source: "llm",
            severity: risk.severity,
            file: risk.file,
            text: risk.reason,
          }),
        )
      : [];
  return [...fromRules, ...fromLlm];
}

/**
 * The rule-based flag that unambiguously covers a label, if any. Only the deterministic
 * categories can be matched automatically: "same rule, same file" is a fact, not an opinion.
 * Whether an LLM remark covers a "semantic" label is a judgment call, left to the human.
 */
export function matchRuleFinding(label: EvalLabel, findings: readonly EvalFinding[]): EvalFinding | undefined {
  if (label.category === "semantic") return undefined;
  return findings.find(
    (finding) =>
      finding.source === "rule" &&
      finding.rule === label.category &&
      (label.file === undefined || finding.file === undefined || finding.file === label.file),
  );
}

/**
 * The starting point for a human to edit: everything that can be decided mechanically is filled
 * in, everything that needs an opinion is null.
 */
export function skeletonJudgment(entry: Pick<DatasetEntry, "labels">, findings: readonly EvalFinding[]): PrJudgment {
  const labels: PrJudgment["labels"] = {};
  const supported = new Set<string>();

  entry.labels.forEach((label, index) => {
    const match = matchRuleFinding(label, findings);
    if (match) {
      labels[String(index)] = match.id;
      supported.add(match.id);
    } else {
      // A rule category with no matching flag is a definite miss. "semantic" needs a human.
      labels[String(index)] = label.category === "semantic" ? null : "none";
    }
  });

  const judged: PrJudgment["findings"] = {};
  for (const finding of findings) judged[finding.id] = supported.has(finding.id) ? true : null;
  return { findings: judged, labels };
}

/** Keeps any verdicts the human already wrote, and adds slots for anything new. */
export function mergeJudgment(existing: PrJudgment | undefined, fresh: PrJudgment): PrJudgment {
  if (!existing) return fresh;
  const keep = <T>(old: Record<string, T>, next: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(next).map(([key, value]) => [key, Object.hasOwn(old, key) ? (old[key] as T) : value]));
  return { findings: keep(existing.findings, fresh.findings), labels: keep(existing.labels, fresh.labels) };
}
