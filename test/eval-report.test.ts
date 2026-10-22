import { describe, expect, it } from "vitest";
import { computeMetrics } from "../src/eval/metrics.js";
import { renderReport } from "../src/eval/report.js";
import type { Dataset, Judgments, RunResults } from "../src/eval/types.js";

const dataset: Dataset = {
  version: 1,
  prs: [
    { id: "a/b#1", url: "u", title: "t", status: "labeled", labels: [
      { category: "sensitivePaths", file: "x", description: "d" },
      { category: "deletedTests", file: "y", description: "d" },
      { category: "semantic", file: "x", description: "d" },
    ] },
    { id: "a/b#2", url: "u", title: "t", status: "labeled", labels: [] },
    { id: "a/b#3", url: "u", title: "t", status: "labeled", labels: [{ category: "secrets", file: "z", description: "d" }] },
  ],
};

const f = (id: string, source: "rule" | "llm") => ({ id, source, severity: "medium" as const, text: "t" });
const results: RunResults = {
  version: 1,
  startedAt: "2026-10-22T00:00:00Z",
  model: "claude-haiku-5-5",
  prs: [
    { id: "a/b#1", durationMs: 1000, collectMs: 2000, findings: [f("r0", "rule"), f("r1", "rule"), f("l0", "llm"), f("l1", "llm")], summary: { status: "ok", mode: "single", calls: 1, inputTokens: 1000, outputTokens: 200 } },
    { id: "a/b#2", durationMs: 3000, collectMs: 2000, findings: [f("l0", "llm")], summary: { status: "ok", mode: "single", calls: 1, inputTokens: 1000, outputTokens: 200 } },
    { id: "a/b#3", durationMs: 2000, collectMs: 2000, findings: [], summary: { status: "ok", mode: "single", calls: 1, inputTokens: 1000, outputTokens: 200 } },
  ],
};
const judged: Judgments = {
  version: 1,
  prs: {
    "a/b#1": { labels: { "0": "r0", "1": "r1", "2": "l0" }, findings: { r0: true, r1: true, l0: null, l1: false } },
    "a/b#2": { labels: {}, findings: { l0: false } },
    "a/b#3": { labels: { "0": "none" }, findings: {} },
  },
};
const pricing = { inputPerMTok: 0.1, outputPerMTok: 0.5 };
const context = { model: "claude-haiku-5-5", pricing, date: "2026-10-22" };

describe("renderReport", () => {
  const complete = renderReport(computeMetrics({ dataset, results, judgments: judged, pricing }), context);

  it("renders the README table exactly (golden)", () => {
    expect(complete).toBe(GOLDEN);
  });

  it("has no draft warning when everything is judged", () => {
    expect(complete).not.toContain("DRAFT");
  });

  it("shows a loud DRAFT banner listing what is missing when judging is unfinished", () => {
    const unfinished = renderReport(computeMetrics({ dataset, results, judgments: null, pricing }), context);
    expect(unfinished.startsWith("> [!WARNING]\n> **DRAFT: not ready to publish.**")).toBe(true);
    expect(unfinished).toContain("labeled risk(s) have no verdict");
  });

  it("copes with a run that had no LLM and no pricing", () => {
    const noLlm: RunResults = {
      ...results,
      model: null,
      prs: results.prs.map((r) => ({ ...r, findings: r.findings.filter((x) => x.source === "rule"), summary: { status: "disabled" as const, inputTokens: 0, outputTokens: 0 } })),
    };
    const out = renderReport(computeMetrics({ dataset, results: noLlm, judgments: null, pricing: null }), { model: null, pricing: null, date: "2026-10-22" });
    expect(out).toContain("with the LLM disabled");
    expect(out).toContain("| LLM cost per PR | not measured |");
    expect(out).toContain("Cost was not computed");
    expect(out).toContain("| Precision, LLM-reported risks | n/a (nothing to measure) |");
  });

  it("uses the singular for a single PR", () => {
    const one = renderReport(computeMetrics({ dataset: { version: 1, prs: [dataset.prs[1]!] }, results: { ...results, prs: [results.prs[1]!] }, judgments: { version: 1, prs: { "a/b#2": judged.prs["a/b#2"]! } }, pricing }), context);
    expect(one).toContain("**1 merged pull request**");
  });
});

const GOLDEN = `## Evaluation results

Evaluated on **3 merged pull requests** from public repositories (1 with no labeled risk), on 2026-10-22 with \`claude-haiku-5-5\`.

| Metric | Result |
| --- | --- |
| Recall, rules + LLM | 75% (3/4, 95% CI 30% to 95%) |
| Recall, rules only | 50% (2/4, 95% CI 15% to 85%) |
| Precision, all flags | 60% (3/5, 95% CI 23% to 88%) |
| Precision, rule-based flags | 100% (2/2, 95% CI 34% to 100%) |
| Precision, LLM-reported risks | 33% (1/3, 95% CI 6% to 79%) |
| Flags per PR | 1.7 (0.7 rule-based, 1.0 from the LLM) |
| False alarms per PR | 0.7 |
| Processing latency per PR | median 2.0 s, mean 2.0 s, p95 3.0 s |
| GitHub data fetch per PR | mean 2.0 s (measured live when collected) |
| LLM cost per PR | $0.0002 mean ($0.0006 total; 1,000 input and 200 output tokens, 1.0 calls per PR) |

**Recall by category**

| Category | Labeled risks | Caught | Recall |
| --- | --- | --- | --- |
| secrets | 1 | 0 | 0% |
| sensitivePaths | 1 | 1 | 100% |
| deletedTests | 1 | 1 | 100% |
| semantic | 1 | 1 | 100% |

**How this was measured**

- 4 risks were labeled by hand after reading each PR, by the project author. The same person judged the tool's flags, so this is a single-rater evaluation, not an independent benchmark.
- A labeled risk counts as caught when a rule flagged the same file and category, or when the LLM reported that risk (judged by hand). Precision is the share of flags a reviewer would agree deserve attention, including real issues that were not in the labels.
- Intervals are Wilson 95% confidence intervals. With 3 PRs they are wide: treat the percentages as indicative, not precise.
- Latency is processing time with GitHub's responses replayed from disk (so it is mostly the LLM call), measured one PR at a time. The live GitHub fetch time was measured separately when each PR was collected.
- Cost is token usage multiplied by $0.1/$0.5 per million input/output tokens. Check the provider's pricing page for current rates.
- The LLM summary succeeded on 3 of 3 PRs (0 failed, 0 used the map-reduce path for large diffs); failed attempts are included in latency and cost.
`;
