import { describe, expect, it } from "vitest";
import { extractFindings, matchRuleFinding, mergeJudgment, skeletonJudgment } from "../src/eval/judge.js";
import type { EvalFinding, EvalLabel } from "../src/eval/types.js";
import type { SummaryResult } from "../src/llm/summarize.js";
import type { SummaryOutcome } from "../src/review/pipeline.js";
import type { RiskFlag } from "../src/risk/types.js";

const flags: RiskFlag[] = [
  { rule: "sensitivePaths", severity: "high", file: "src/auth/login.ts", reason: "Touches security-sensitive code" },
  { rule: "secrets", severity: "critical", file: "src/config.ts", line: 4, reason: "Likely AWS access key ID added" },
  { rule: "largeDiff", severity: "medium", reason: "Large change: 900 lines" },
];

const llmResult: SummaryResult = {
  summary: {
    summary: "s",
    keyChanges: [],
    risks: [
      { file: "src/auth/login.ts", reason: "Audit write is not awaited", severity: "medium" },
      { file: "README.md", reason: "Nit", severity: "low" },
    ],
    testingSuggestions: [],
  },
  usage: { inputTokens: 1, outputTokens: 1 },
  calls: 1,
  mode: "single",
};

describe("extractFindings", () => {
  it("numbers rule flags r0.. and LLM risks l0.., keeping file, line and text", () => {
    const summary: SummaryOutcome = { status: "ok", result: llmResult };
    expect(extractFindings({ flags, summary })).toEqual([
      { id: "r0", source: "rule", rule: "sensitivePaths", severity: "high", file: "src/auth/login.ts", line: undefined, text: "Touches security-sensitive code" },
      { id: "r1", source: "rule", rule: "secrets", severity: "critical", file: "src/config.ts", line: 4, text: "Likely AWS access key ID added" },
      { id: "r2", source: "rule", rule: "largeDiff", severity: "medium", file: undefined, line: undefined, text: "Large change: 900 lines" },
      { id: "l0", source: "llm", severity: "medium", file: "src/auth/login.ts", text: "Audit write is not awaited" },
      { id: "l1", source: "llm", severity: "low", file: "README.md", text: "Nit" },
    ]);
  });

  it("has no LLM findings when the summary failed or was disabled", () => {
    for (const summary of [{ status: "failed", error: "x" }, { status: "disabled" }] as SummaryOutcome[]) {
      expect(extractFindings({ flags, summary }).map((f) => f.id)).toEqual(["r0", "r1", "r2"]);
    }
  });
});

describe("matchRuleFinding", () => {
  const findings = extractFindings({ flags, summary: { status: "ok", result: llmResult } });
  const label = (over: Partial<EvalLabel>): EvalLabel => ({ category: "sensitivePaths", description: "d", ...over });

  it("matches the same rule on the same file", () => {
    expect(matchRuleFinding(label({ file: "src/auth/login.ts" }), findings)?.id).toBe("r0");
    expect(matchRuleFinding(label({ category: "secrets", file: "src/config.ts" }), findings)?.id).toBe("r1");
  });

  it("matches on the rule alone when the label names no file", () => {
    expect(matchRuleFinding(label({ category: "secrets" }), findings)?.id).toBe("r1");
  });

  it("matches a PR-wide flag (no file) to a label, whichever file the label names", () => {
    expect(matchRuleFinding(label({ category: "largeDiff", file: "anything.ts" }), findings)?.id).toBe("r2");
  });

  it("does not match a different file or a different rule", () => {
    expect(matchRuleFinding(label({ file: "src/other.ts" }), findings)).toBeUndefined();
    expect(matchRuleFinding(label({ category: "migrations", file: "src/auth/login.ts" }), findings)).toBeUndefined();
  });

  it("never matches 'semantic' labels automatically, and never matches LLM findings", () => {
    expect(matchRuleFinding(label({ category: "semantic", file: "src/auth/login.ts" }), findings)).toBeUndefined();
    const onlyLlm: EvalFinding[] = findings.filter((f) => f.source === "llm");
    expect(matchRuleFinding(label({ file: "src/auth/login.ts" }), onlyLlm)).toBeUndefined();
  });
});

describe("skeletonJudgment", () => {
  const findings = extractFindings({ flags, summary: { status: "ok", result: llmResult } });

  it("fills in what is mechanical and leaves opinions as null", () => {
    const skeleton = skeletonJudgment(
      {
        labels: [
          { category: "sensitivePaths", file: "src/auth/login.ts", description: "auth" }, // rule caught it
          { category: "migrations", file: "db/001.sql", description: "migration" }, // rule category, no flag: a miss
          { category: "semantic", file: "src/auth/login.ts", description: "bug" }, // needs a human
        ],
      },
      findings,
    );
    expect(skeleton.labels).toEqual({ "0": "r0", "1": "none", "2": null });
    expect(skeleton.findings).toEqual({ r0: true, r1: null, r2: null, l0: null, l1: null });
  });

  it("handles a PR with no labels and no findings", () => {
    expect(skeletonJudgment({ labels: [] }, [])).toEqual({ findings: {}, labels: {} });
  });
});

describe("mergeJudgment", () => {
  const fresh = { findings: { r0: true, l0: null, l1: null }, labels: { "0": "r0", "1": null } };

  it("returns the fresh skeleton when nothing exists yet", () => {
    expect(mergeJudgment(undefined, fresh)).toBe(fresh);
  });

  it("keeps verdicts the human already wrote, adds new slots, and drops ids that no longer exist", () => {
    const existing = { findings: { r0: false, l0: true, gone: true }, labels: { "1": "l0", "7": "none" } };
    expect(mergeJudgment(existing, fresh)).toEqual({
      findings: { r0: false, l0: true, l1: null },
      labels: { "0": "r0", "1": "l0" },
    });
  });
});
