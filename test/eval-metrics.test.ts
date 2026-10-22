import { describe, expect, it } from "vitest";
import { computeMetrics, costUsd, mean, median, percentile, proportion } from "../src/eval/metrics.js";
import type { Dataset, DatasetEntry, EvalFinding, Judgments, PrResult, RunResults } from "../src/eval/types.js";

describe("proportion (Wilson 95% interval)", () => {
  const round = (n: number | null) => (n === null ? null : Math.round(n * 10000) / 10000);

  it.each([
    [8, 10, 0.4902, 0.9433],
    [0, 10, 0, 0.2775],
    [10, 10, 0.7225, 1],
    [28, 41, 0.5302, 0.8044],
    [3, 4, 0.3006, 0.9544],
    [1, 1, 0.2065, 1],
  ])("%i out of %i", (k, n, low, high) => {
    const p = proportion(k, n);
    expect(p.rate).toBe(k / n);
    expect(round(p.low)).toBe(low);
    expect(round(p.high)).toBe(high);
  });

  it("is undefined when there is nothing to measure", () => {
    expect(proportion(0, 0)).toEqual({ k: 0, n: 0, rate: null, low: null, high: null });
  });
});

describe("summary statistics", () => {
  it("mean", () => {
    expect(mean([1, 2, 3, 6])).toBe(3);
    expect(mean([])).toBeNull();
  });

  it("median handles odd, even, unsorted and empty input", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNull();
  });

  it("percentile uses the nearest rank", () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    expect(percentile(values, 95)).toBe(19);
    expect(percentile(values, 50)).toBe(10);
    expect(percentile(values, 100)).toBe(20);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile([9, 1, 5], 95)).toBe(9);
    expect(percentile([], 95)).toBeNull();
  });

  it("costUsd multiplies tokens by the per-million prices", () => {
    expect(costUsd({ inputTokens: 1000, outputTokens: 200 }, { inputPerMTok: 0.1, outputPerMTok: 0.5 })).toBeCloseTo(0.0002, 10);
    expect(costUsd({ inputTokens: 0, outputTokens: 0 }, { inputPerMTok: 5, outputPerMTok: 25 })).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------

const finding = (id: string, over: Partial<EvalFinding> = {}): EvalFinding => ({
  id,
  source: id.startsWith("r") ? "rule" : "llm",
  severity: "medium",
  text: "text",
  ...(id.startsWith("r") ? { rule: "sensitivePaths" } : {}),
  ...over,
});

const result = (id: string, findings: EvalFinding[], over: Partial<PrResult> = {}): PrResult => ({
  id,
  durationMs: 1000,
  collectMs: 2000,
  findings,
  summary: { status: "ok", mode: "single", calls: 1, inputTokens: 1000, outputTokens: 200 },
  ...over,
});

const entry = (id: string, labels: DatasetEntry["labels"], status: DatasetEntry["status"] = "labeled"): DatasetEntry => ({
  id,
  url: `https://github.com/${id}`,
  title: id,
  status,
  labels,
});

const run = (prs: PrResult[]): RunResults => ({ version: 1, startedAt: "2026-10-22T00:00:00Z", model: "m", prs });
const dataset = (...prs: DatasetEntry[]): Dataset => ({ version: 1, prs });
const verdicts = (prs: Judgments["prs"]): Judgments => ({ version: 1, prs });
const pricing = { inputPerMTok: 0.1, outputPerMTok: 0.5 };

describe("computeMetrics: a fully judged evaluation", () => {
  // Same scenario the end-to-end test drives through real files; here the numbers are worked by hand.
  const data = dataset(
    entry("a/b#1", [
      { category: "sensitivePaths", file: "x", description: "d" },
      { category: "deletedTests", file: "y", description: "d" },
      { category: "semantic", file: "x", description: "d" },
    ]),
    entry("a/b#2", []),
    entry("a/b#3", [{ category: "secrets", file: "z", description: "d" }]),
  );
  const results = run([
    result("a/b#1", [finding("r0"), finding("r1"), finding("l0"), finding("l1")], { durationMs: 1000 }),
    result("a/b#2", [finding("l0")], { durationMs: 3000 }),
    result("a/b#3", [], { durationMs: 2000 }),
  ]);
  const judged = verdicts({
    "a/b#1": { labels: { "0": "r0", "1": "r1", "2": "l0" }, findings: { r0: true, r1: true, l0: null, l1: false } },
    "a/b#2": { labels: {}, findings: { l0: false } },
    "a/b#3": { labels: { "0": "none" }, findings: {} },
  });
  const m = computeMetrics({ dataset: data, results, judgments: judged, pricing });

  it("counts PRs and labels", () => {
    expect(m.prs).toEqual({ evaluated: 3, clean: 1, unlabeledSkipped: 0, missingResults: 0 });
    expect(m.labels).toEqual({ total: 4, caught: 3, missed: 1, pending: 0, caughtByRules: 2, caughtByLlm: 1 });
  });

  it("computes recall with and without the LLM", () => {
    expect(m.recall).toMatchObject({ k: 3, n: 4, rate: 0.75 });
    expect(m.recallRulesOnly).toMatchObject({ k: 2, n: 4, rate: 0.5 });
  });

  it("computes precision overall and per source, crediting a finding that caught a labeled risk", () => {
    expect(m.precision.all).toMatchObject({ k: 3, n: 5 });
    expect(m.precision.rules).toMatchObject({ k: 2, n: 2, rate: 1 });
    expect(m.precision.llm).toMatchObject({ k: 1, n: 3 }); // PR1's l0 counts as reasonable because it caught a label
  });

  it("breaks recall down by category", () => {
    expect(m.byCategory.sensitivePaths).toEqual({ total: 1, caught: 1, missed: 0, pending: 0 });
    expect(m.byCategory.deletedTests).toEqual({ total: 1, caught: 1, missed: 0, pending: 0 });
    expect(m.byCategory.semantic).toEqual({ total: 1, caught: 1, missed: 0, pending: 0 });
    expect(m.byCategory.secrets).toEqual({ total: 1, caught: 0, missed: 1, pending: 0 });
    expect(m.byCategory.migrations.total).toBe(0);
  });

  it("computes per-PR rates", () => {
    expect(m.findings).toEqual({ total: 5, rules: 2, llm: 3, pending: 0, unreasonable: 2 });
    expect(m.perPr.findings).toBeCloseTo(5 / 3, 10);
    expect(m.perPr.ruleFindings).toBeCloseTo(2 / 3, 10);
    expect(m.perPr.llmFindings).toBe(1);
    expect(m.perPr.unreasonable).toBeCloseTo(2 / 3, 10);
  });

  it("summarizes latency and the GitHub fetch time", () => {
    expect(m.latencyMs).toEqual({ mean: 2000, median: 2000, p95: 3000, max: 3000 });
    expect(m.collectMs.mean).toBe(2000);
  });

  it("computes cost from token usage", () => {
    expect(m.cost?.meanUsd).toBeCloseTo(0.0002, 10);
    expect(m.cost?.totalUsd).toBeCloseTo(0.0006, 10);
    expect(m.cost).toMatchObject({ meanInputTokens: 1000, meanOutputTokens: 200, meanCalls: 1 });
  });

  it("is complete, with no warnings", () => {
    expect(m.complete).toBe(true);
    expect(m.warnings).toEqual([]);
    expect(m.llm).toEqual({ ok: 3, failed: 0, disabled: 0, mapReduce: 0 });
  });
});

describe("computeMetrics: unfinished or inconsistent input", () => {
  const data = dataset(entry("a/b#1", [{ category: "semantic", file: "x", description: "d" }]));
  const results = run([result("a/b#1", [finding("l0"), finding("l1")])]);

  it("reports undecided verdicts as pending, leaves them out of the rates, and is incomplete", () => {
    const m = computeMetrics({ dataset: data, results, judgments: verdicts({ "a/b#1": { labels: { "0": null }, findings: { l0: true, l1: null } } }), pricing: null });
    expect(m.labels).toMatchObject({ pending: 1, caught: 0, missed: 0 });
    expect(m.recall).toMatchObject({ n: 0, rate: null });
    expect(m.precision.all).toMatchObject({ k: 1, n: 1 });
    expect(m.findings.pending).toBe(1);
    expect(m.complete).toBe(false);
    expect(m.warnings.join("\n")).toContain("1 labeled risk(s) have no verdict");
    expect(m.warnings.join("\n")).toContain("1 finding(s) have no verdict");
  });

  it("treats a missing judgments file as everything pending", () => {
    const m = computeMetrics({ dataset: data, results, judgments: null, pricing: null });
    expect(m.labels.pending).toBe(1);
    expect(m.findings.pending).toBe(2);
    expect(m.complete).toBe(false);
  });

  it("treats a label credited to a finding that doesn't exist as pending, with a warning", () => {
    const m = computeMetrics({ dataset: data, results, judgments: verdicts({ "a/b#1": { labels: { "0": "l9" }, findings: { l0: true, l1: true } } }), pricing: null });
    expect(m.labels.pending).toBe(1);
    expect(m.warnings.join("\n")).toContain('names finding "l9"');
    expect(m.complete).toBe(false);
  });

  it("flags a contradiction (marked noise, yet credited with catching a risk) and counts it as reasonable", () => {
    const m = computeMetrics({ dataset: data, results, judgments: verdicts({ "a/b#1": { labels: { "0": "l0" }, findings: { l0: false, l1: true } } }), pricing: null });
    expect(m.precision.llm).toMatchObject({ k: 2, n: 2 });
    expect(m.warnings.join("\n")).toContain("finding l0 is marked unreasonable");
    expect(m.complete).toBe(true); // a contradiction is worth a warning, not a block
  });

  it("leaves unlabeled PRs out (noted, not blocking) and flags labeled PRs with no result", () => {
    const withExtras = dataset(entry("a/b#1", []), entry("a/b#2", [], "unlabeled"), entry("a/b#3", []));
    const m = computeMetrics({ dataset: withExtras, results: run([result("a/b#1", []), result("a/b#2", [])]), judgments: verdicts({ "a/b#1": { labels: {}, findings: {} } }), pricing: null });
    expect(m.prs).toEqual({ evaluated: 1, clean: 1, unlabeledSkipped: 1, missingResults: 1 });
    expect(m.complete).toBe(false);
    expect(m.warnings.join("\n")).toContain("still \"unlabeled\"");
  });

  it("has no cost when no pricing is given or the LLM was disabled", () => {
    const judged = verdicts({ "a/b#1": { labels: { "0": "none" }, findings: { l0: true, l1: true } } });
    expect(computeMetrics({ dataset: data, results, judgments: judged, pricing: null }).cost).toBeNull();

    const disabled = run([result("a/b#1", [], { summary: { status: "disabled", inputTokens: 0, outputTokens: 0 } })]);
    expect(computeMetrics({ dataset: data, results: disabled, judgments: judged, pricing }).cost).toBeNull();
  });

  it("counts failed summaries and map-reduce runs, and includes tokens spent on failed attempts in cost", () => {
    const mixed = run([
      result("a/b#1", [], { summary: { status: "failed", error: "bad json", inputTokens: 500, outputTokens: 100 } }),
      result("a/b#2", [], { summary: { status: "ok", mode: "map-reduce", calls: 5, inputTokens: 5000, outputTokens: 500 } }),
    ]);
    const m = computeMetrics({ dataset: dataset(entry("a/b#1", []), entry("a/b#2", [])), results: mixed, judgments: verdicts({ "a/b#1": { labels: {}, findings: {} }, "a/b#2": { labels: {}, findings: {} } }), pricing });
    expect(m.llm).toEqual({ ok: 1, failed: 1, disabled: 0, mapReduce: 1 });
    expect(m.cost?.totalUsd).toBeCloseTo((500 * 0.1 + 100 * 0.5 + 5000 * 0.1 + 500 * 0.5) / 1e6, 10);
    expect(m.cost?.meanCalls).toBe(2.5);
  });

  it("handles an empty evaluation without dividing by zero", () => {
    const m = computeMetrics({ dataset: dataset(), results: run([]), judgments: null, pricing });
    expect(m.prs.evaluated).toBe(0);
    expect(m.recall.rate).toBeNull();
    expect(m.perPr.findings).toBeNull();
    expect(m.latencyMs).toEqual({ mean: null, median: null, p95: null, max: null });
    expect(m.cost).toBeNull();
    expect(m.complete).toBe(false);
  });
});
