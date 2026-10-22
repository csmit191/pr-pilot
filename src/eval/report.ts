import type { Metrics, Proportion } from "./metrics.js";
import { LABEL_CATEGORIES, type Pricing } from "./types.js";

export interface ReportContext {
  /** The LLM used, or null if the run had none. */
  model: string | null;
  pricing: Pricing | null;
  /** YYYY-MM-DD */
  date: string;
}

const pct = (rate: number): string => `${Math.round(rate * 100)}%`;

function formatProportion(p: Proportion): string {
  if (p.rate === null) return "n/a (nothing to measure)";
  return `${pct(p.rate)} (${p.k}/${p.n}, 95% CI ${pct(p.low ?? 0)} to ${pct(p.high ?? 1)})`;
}

const seconds = (ms: number | null): string => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const usd = (n: number): string => (n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`);
const one = (n: number | null): string => (n === null ? "n/a" : n.toFixed(1));
const whole = (n: number): string => Math.round(n).toLocaleString("en-US");
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The markdown that goes into the README (and, when judging is unfinished, a loud DRAFT warning). */
export function renderReport(metrics: Metrics, context: ReportContext): string {
  const { prs, labels } = metrics;
  const lines: string[] = [];

  if (!metrics.complete) {
    lines.push(
      "> [!WARNING]",
      "> **DRAFT: not ready to publish.** Some verdicts are still missing, so these numbers are incomplete:",
      ...metrics.warnings.map((w) => `> - ${w}`),
      "",
    );
  }

  lines.push(
    "## Evaluation results",
    "",
    `Evaluated on **${plural(prs.evaluated, "merged pull request")}** from public repositories (${prs.clean} with no labeled risk), on ${context.date}${context.model ? ` with \`${context.model}\`` : " with the LLM disabled"}.`,
    "",
    "| Metric | Result |",
    "| --- | --- |",
    `| Recall, rules + LLM | ${formatProportion(metrics.recall)} |`,
    `| Recall, rules only | ${formatProportion(metrics.recallRulesOnly)} |`,
    `| Precision, all flags | ${formatProportion(metrics.precision.all)} |`,
    `| Precision, rule-based flags | ${formatProportion(metrics.precision.rules)} |`,
    `| Precision, LLM-reported risks | ${formatProportion(metrics.precision.llm)} |`,
    `| Flags per PR | ${one(metrics.perPr.findings)} (${one(metrics.perPr.ruleFindings)} rule-based, ${one(metrics.perPr.llmFindings)} from the LLM) |`,
    `| False alarms per PR | ${one(metrics.perPr.unreasonable)} |`,
    `| Processing latency per PR | median ${seconds(metrics.latencyMs.median)}, mean ${seconds(metrics.latencyMs.mean)}, p95 ${seconds(metrics.latencyMs.p95)} |`,
    `| GitHub data fetch per PR | mean ${seconds(metrics.collectMs.mean)} (measured live when collected) |`,
    `| LLM cost per PR | ${
      metrics.cost
        ? `${usd(metrics.cost.meanUsd)} mean (${usd(metrics.cost.totalUsd)} total; ${whole(metrics.cost.meanInputTokens)} input and ${whole(metrics.cost.meanOutputTokens)} output tokens, ${one(metrics.cost.meanCalls)} calls per PR)`
        : "not measured"
    } |`,
    "",
    "**Recall by category**",
    "",
    "| Category | Labeled risks | Caught | Recall |",
    "| --- | --- | --- | --- |",
  );

  for (const category of LABEL_CATEGORIES) {
    const tally = metrics.byCategory[category];
    if (tally.total === 0) continue;
    const judged = tally.caught + tally.missed;
    lines.push(`| ${category} | ${tally.total} | ${tally.caught} | ${judged === 0 ? "n/a" : pct(tally.caught / judged)} |`);
  }

  lines.push(
    "",
    "**How this was measured**",
    "",
    `- ${plural(labels.total, "risk")} were labeled by hand after reading each PR, by the project author. The same person judged the tool's flags, so this is a single-rater evaluation, not an independent benchmark.`,
    "- A labeled risk counts as caught when a rule flagged the same file and category, or when the LLM reported that risk (judged by hand). Precision is the share of flags a reviewer would agree deserve attention, including real issues that were not in the labels.",
    `- Intervals are Wilson 95% confidence intervals. With ${plural(prs.evaluated, "PR")} they are wide: treat the percentages as indicative, not precise.`,
    "- Latency is processing time with GitHub's responses replayed from disk (so it is mostly the LLM call), measured one PR at a time. The live GitHub fetch time was measured separately when each PR was collected.",
    context.pricing
      ? `- Cost is token usage multiplied by $${context.pricing.inputPerMTok}/$${context.pricing.outputPerMTok} per million input/output tokens. Check the provider's pricing page for current rates.`
      : "- Cost was not computed (no pricing was provided).",
    `- The LLM summary succeeded on ${metrics.llm.ok} of ${prs.evaluated} PRs (${metrics.llm.failed} failed, ${metrics.llm.mapReduce} used the map-reduce path for large diffs); failed attempts are included in latency and cost.`,
    "",
  );
  return lines.join("\n");
}
