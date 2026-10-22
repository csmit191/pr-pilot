import { LABEL_CATEGORIES, type Dataset, type EvalFinding, type Judgments, type LabelCategory, type Pricing, type RunResults } from "./types.js";

export interface Proportion {
  k: number;
  n: number;
  rate: number | null;
  /** Wilson 95% confidence interval. */
  low: number | null;
  high: number | null;
}

/**
 * k successes out of n, with a Wilson score interval. With 20-30 PRs the intervals are wide,
 * and reporting them is the honest way to say so (the plain normal approximation is poor for
 * small n and for rates near 0% or 100%).
 */
export function proportion(k: number, n: number): Proportion {
  if (n === 0) return { k, n, rate: null, low: null, high: null };
  const z = 1.96;
  const p = k / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return { k, n, rate: p, low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Nearest-rank percentile (p in 0..100). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

export const costUsd = (usage: { inputTokens: number; outputTokens: number }, pricing: Pricing): number =>
  (usage.inputTokens * pricing.inputPerMTok + usage.outputTokens * pricing.outputPerMTok) / 1_000_000;

export interface CategoryTally {
  total: number;
  caught: number;
  missed: number;
  pending: number;
}

export interface Metrics {
  prs: { evaluated: number; clean: number; unlabeledSkipped: number; missingResults: number };
  labels: { total: number; caught: number; missed: number; pending: number; caughtByRules: number; caughtByLlm: number };
  byCategory: Record<LabelCategory, CategoryTally>;
  recall: Proportion;
  recallRulesOnly: Proportion;
  precision: { all: Proportion; rules: Proportion; llm: Proportion };
  findings: { total: number; rules: number; llm: number; pending: number; unreasonable: number };
  perPr: { findings: number | null; ruleFindings: number | null; llmFindings: number | null; unreasonable: number | null };
  latencyMs: { mean: number | null; median: number | null; p95: number | null; max: number | null };
  collectMs: { mean: number | null };
  cost: { meanUsd: number; totalUsd: number; meanInputTokens: number; meanOutputTokens: number; meanCalls: number } | null;
  llm: { ok: number; failed: number; disabled: number; mapReduce: number };
  /** true only when every label and finding has a verdict and every labeled PR has a result. */
  complete: boolean;
  warnings: string[];
}

export interface MetricsInput {
  dataset: Dataset;
  results: RunResults;
  judgments: Judgments | null;
  pricing: Pricing | null;
}

const emptyTally = (): CategoryTally => ({ total: 0, caught: 0, missed: 0, pending: 0 });

export function computeMetrics({ dataset, results, judgments, pricing }: MetricsInput): Metrics {
  const warnings: string[] = [];
  const resultById = new Map(results.prs.map((r) => [r.id, r]));

  let unlabeledSkipped = 0;
  let missingResults = 0;
  let clean = 0;
  const byCategory = Object.fromEntries(LABEL_CATEGORIES.map((c) => [c, emptyTally()])) as Record<LabelCategory, CategoryTally>;

  const labelTotals = { total: 0, caught: 0, missed: 0, pending: 0, caughtByRules: 0, caughtByLlm: 0 };
  const findingTotals = { rules: 0, llm: 0, reasonableRules: 0, reasonableLlm: 0, unreasonableRules: 0, unreasonableLlm: 0, pending: 0 };
  const evaluatedResults: RunResults["prs"] = [];

  for (const entry of dataset.prs) {
    if (entry.status !== "labeled") {
      unlabeledSkipped++;
      continue;
    }
    const result = resultById.get(entry.id);
    if (!result) {
      missingResults++;
      continue;
    }
    evaluatedResults.push(result);
    if (entry.labels.length === 0) clean++;

    const verdicts = judgments?.prs[entry.id];
    const findingById = new Map<string, EvalFinding>(result.findings.map((f) => [f.id, f]));
    const supportedByLabel = new Set<string>();

    entry.labels.forEach((label, index) => {
      const tally = byCategory[label.category];
      tally.total++;
      labelTotals.total++;

      const verdict = verdicts?.labels[String(index)] ?? null;
      if (verdict === null) {
        tally.pending++;
        labelTotals.pending++;
      } else if (verdict === "none") {
        tally.missed++;
        labelTotals.missed++;
      } else {
        const finding = findingById.get(verdict);
        if (!finding) {
          warnings.push(`${entry.id}: label ${index} names finding "${verdict}", which does not exist in this run; counted as pending.`);
          tally.pending++;
          labelTotals.pending++;
        } else {
          tally.caught++;
          labelTotals.caught++;
          if (finding.source === "rule") labelTotals.caughtByRules++;
          else labelTotals.caughtByLlm++;
          supportedByLabel.add(finding.id);
        }
      }
    });

    for (const finding of result.findings) {
      if (finding.source === "rule") findingTotals.rules++;
      else findingTotals.llm++;

      const explicit = verdicts?.findings[finding.id] ?? null;
      // A flag that caught a labeled risk is, by definition, a reasonable flag.
      if (supportedByLabel.has(finding.id) && explicit === false) {
        warnings.push(`${entry.id}: finding ${finding.id} is marked unreasonable but is credited with catching a labeled risk; counted as reasonable.`);
      }
      const effective = supportedByLabel.has(finding.id) ? true : explicit;

      if (effective === null) {
        findingTotals.pending++;
      } else if (finding.source === "rule") {
        if (effective) findingTotals.reasonableRules++;
        else findingTotals.unreasonableRules++;
      } else if (effective) {
        findingTotals.reasonableLlm++;
      } else {
        findingTotals.unreasonableLlm++;
      }
    }
  }

  const evaluated = evaluatedResults.length;
  const judgedLabels = labelTotals.caught + labelTotals.missed;
  const judgedRules = findingTotals.reasonableRules + findingTotals.unreasonableRules;
  const judgedLlm = findingTotals.reasonableLlm + findingTotals.unreasonableLlm;
  const totalFindings = findingTotals.rules + findingTotals.llm;
  const unreasonable = findingTotals.unreasonableRules + findingTotals.unreasonableLlm;

  if (labelTotals.pending > 0) warnings.push(`${labelTotals.pending} labeled risk(s) have no verdict yet (set each to a finding id, or "none").`);
  if (findingTotals.pending > 0) warnings.push(`${findingTotals.pending} finding(s) have no verdict yet (set each to true or false).`);
  if (unlabeledSkipped > 0) warnings.push(`${unlabeledSkipped} PR(s) are still "unlabeled" and were left out.`);
  if (missingResults > 0) warnings.push(`${missingResults} labeled PR(s) have no result in this run (run \`eval:run\` after \`eval:collect\`).`);

  const perPr = (n: number): number | null => (evaluated === 0 ? null : n / evaluated);
  const durations = evaluatedResults.map((r) => r.durationMs);

  let cost: Metrics["cost"] = null;
  if (pricing && evaluated > 0 && evaluatedResults.some((r) => r.summary.status !== "disabled")) {
    const perPrCost = evaluatedResults.map((r) => costUsd(r.summary, pricing));
    const totalUsd = perPrCost.reduce((sum, c) => sum + c, 0);
    cost = {
      totalUsd,
      meanUsd: totalUsd / evaluated,
      meanInputTokens: (mean(evaluatedResults.map((r) => r.summary.inputTokens)) as number),
      meanOutputTokens: (mean(evaluatedResults.map((r) => r.summary.outputTokens)) as number),
      meanCalls: (mean(evaluatedResults.map((r) => r.summary.calls ?? 0)) as number),
    };
  }

  return {
    prs: { evaluated, clean, unlabeledSkipped, missingResults },
    labels: labelTotals,
    byCategory,
    recall: proportion(labelTotals.caught, judgedLabels),
    recallRulesOnly: proportion(labelTotals.caughtByRules, judgedLabels),
    precision: {
      all: proportion(findingTotals.reasonableRules + findingTotals.reasonableLlm, judgedRules + judgedLlm),
      rules: proportion(findingTotals.reasonableRules, judgedRules),
      llm: proportion(findingTotals.reasonableLlm, judgedLlm),
    },
    findings: { total: totalFindings, rules: findingTotals.rules, llm: findingTotals.llm, pending: findingTotals.pending, unreasonable },
    perPr: {
      findings: perPr(totalFindings),
      ruleFindings: perPr(findingTotals.rules),
      llmFindings: perPr(findingTotals.llm),
      unreasonable: perPr(unreasonable),
    },
    latencyMs: { mean: mean(durations), median: median(durations), p95: percentile(durations, 95), max: durations.length ? Math.max(...durations) : null },
    collectMs: { mean: mean(evaluatedResults.map((r) => r.collectMs)) },
    cost,
    llm: {
      ok: evaluatedResults.filter((r) => r.summary.status === "ok").length,
      failed: evaluatedResults.filter((r) => r.summary.status === "failed").length,
      disabled: evaluatedResults.filter((r) => r.summary.status === "disabled").length,
      mapReduce: evaluatedResults.filter((r) => r.summary.mode === "map-reduce").length,
    },
    // Unlabeled PRs are simply left out; what blocks publishing is anything undecided or missing.
    complete: evaluated > 0 && labelTotals.pending === 0 && findingTotals.pending === 0 && missingResults === 0,
    warnings,
  };
}
