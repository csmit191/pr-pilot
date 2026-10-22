import { describe, expect, it } from "vitest";
import { MARKER, MAX_COMMENT_CHARS, renderComment, type RenderInput } from "../src/comment/render.js";
import type { SummaryResult } from "../src/llm/summarize.js";
import type { ReviewerSuggestion } from "../src/reviewers/score.js";
import type { RiskFlag } from "../src/risk/types.js";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";

const reviewResult = (overrides: Partial<SummaryResult["summary"]> = {}): SummaryResult => ({
  summary: {
    summary: "Adds audit logging to the login flow.",
    keyChanges: ["Writes an audit entry on every login"],
    risks: [],
    testingSuggestions: ["Verify a failed login is also audited"],
    ...overrides,
  },
  usage: { inputTokens: 1000, outputTokens: 200 },
  calls: 1,
  mode: "single",
});

const alice: ReviewerSuggestion = {
  handle: "alice",
  kind: "user",
  score: 200,
  ownedFiles: 2,
  recentFiles: 0,
  reasons: ["owns 2 changed files (CODEOWNERS)"],
};
const platform: ReviewerSuggestion = {
  handle: "acme/platform",
  kind: "team",
  score: 100,
  ownedFiles: 1,
  recentFiles: 0,
  reasons: ["owns 1 changed file (CODEOWNERS)"],
};

const flag = (overrides: Partial<RiskFlag> = {}): RiskFlag => ({
  rule: "sensitivePaths",
  severity: "high",
  reason: "Touches security-sensitive code (matches **/auth/**)",
  file: "src/auth/login.ts",
  ...overrides,
});

const input = (overrides: Partial<RenderInput> = {}): RenderInput => ({
  flags: [],
  summary: { status: "disabled" },
  reviewers: [],
  headSha: SHA,
  ...overrides,
});

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("renderComment: structure", () => {
  it("starts with the hidden marker and ends with a newline", () => {
    const out = renderComment(input());
    expect(out.startsWith(`${MARKER}\n`)).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
    expect(count(out, MARKER)).toBe(1);
  });

  it("renders a complete review exactly as expected (golden)", () => {
    const out = renderComment(
      input({
        flags: [flag({ rule: "secrets", severity: "critical", reason: "Likely AWS access key ID added", file: "src/config.ts", line: 12 }), flag()],
        summary: {
          status: "ok",
          result: reviewResult({
            risks: [{ file: "src/auth/login.ts", reason: "Audit write is not awaited", severity: "medium" }],
          }),
        },
        reviewers: [alice, platform],
      }),
    );
    expect(out).toBe(GOLDEN);
  });

  it("shows only the checks when the AI summary is disabled", () => {
    const out = renderComment(input({ flags: [flag()] }));
    expect(out).not.toContain("### Summary");
    expect(out).not.toContain("[!NOTE]");
    expect(out).toContain("### ⚠️ Automated checks (1)");
  });

  it("explains a failed AI summary but still shows checks and reviewers", () => {
    const out = renderComment(input({ flags: [flag()], summary: { status: "failed", error: "HTTP 529" }, reviewers: [alice] }));
    expect(out).toContain("[!NOTE]");
    expect(out).toContain("AI summary was unavailable");
    expect(out).toContain("### ⚠️ Automated checks (1)");
    expect(out).toContain("### 👥 Suggested reviewers");
    expect(out).not.toContain("HTTP 529"); // internal error details aren't shown on the PR
  });

  it("reports a clean result when no rule fired", () => {
    expect(renderComment(input())).toContain("### ✅ Automated checks\nNo risky changes");
  });

  it("omits optional sections when they are empty", () => {
    const out = renderComment(
      input({ summary: { status: "ok", result: reviewResult({ keyChanges: [], testingSuggestions: [], risks: [] }) } }),
    );
    expect(out).toContain("### Summary");
    for (const absent of ["Key changes", "Suggested tests", "Risks noted", "Suggested reviewers"]) {
      expect(out).not.toContain(absent);
    }
  });

  it("shows the reviewed commit, or 'unknown' for something that isn't a SHA", () => {
    expect(renderComment(input())).toContain("Reviewed commit `abcdef0`");
    expect(renderComment(input({ headSha: "<script>" }))).toContain("Reviewed commit `unknown`");
  });
});

describe("renderComment: warnings", () => {
  it("adds a caution banner for critical findings, with rotation advice for secrets", () => {
    const secret = flag({ rule: "secrets", severity: "critical", reason: "Likely AWS access key ID added", file: "a.ts", line: 1 });
    const out = renderComment(input({ flags: [secret] }));
    expect(out).toContain("> [!CAUTION]\n> **1 critical finding.**");
    expect(out).toContain("rotate it");
  });

  it("omits the rotation advice when a critical finding isn't a secret, and the banner when nothing is critical", () => {
    const notSecret = flag({ severity: "critical" });
    expect(renderComment(input({ flags: [notSecret] }))).not.toContain("rotate");
    expect(renderComment(input({ flags: [flag()] }))).not.toContain("[!CAUTION]");
  });

  it("pluralizes the banner", () => {
    const two = [flag({ severity: "critical" }), flag({ severity: "critical", file: "b.ts" })];
    expect(renderComment(input({ flags: two }))).toContain("**2 critical findings.**");
  });

  it("shows a configuration warning, sanitized", () => {
    const out = renderComment(input({ configWarning: ".prpilot.yml is invalid (rules.x: <b>bad</b> @octocat); using defaults." }));
    expect(out).toContain("> [!WARNING]\n> .prpilot.yml is invalid");
    expect(out).toContain("&lt;b>bad&lt;/b>");
    expect(out).not.toMatch(/@[A-Za-z]/);
  });
});

describe("renderComment: findings table", () => {
  it("renders file and line, or 'Whole PR' for PR-level findings, in the given order", () => {
    const out = renderComment(
      input({
        flags: [
          flag({ severity: "critical", file: "src/a.ts", line: 3, reason: "first" }),
          flag({ severity: "medium", file: undefined, reason: "second" }),
        ],
      }),
    );
    const rows = out.split("\n").filter((l) => l.startsWith("| 🔴") || l.startsWith("| 🟡"));
    expect(rows).toEqual(["| 🔴 critical | `src/a.ts:3` | first |", "| 🟡 medium | Whole PR | second |"]);
  });

  it("keeps hostile text from breaking the table", () => {
    const out = renderComment(
      input({ flags: [flag({ file: "we|ird`name.ts", reason: "has | pipe\nand newline" })] }),
    );
    const row = out.split("\n").find((l) => l.startsWith("| 🟠")) ?? "";
    expect(row.match(/(?<!\\)\|/g)).toHaveLength(4); // exactly three cells
    expect(row).toContain("has \\| pipe and newline");
  });

  it("collapses long tables into <details>, but not short ones", () => {
    const many = Array.from({ length: 11 }, (_, i) => flag({ file: `f${i}.ts` }));
    expect(renderComment(input({ flags: many }))).toContain("<details>\n<summary>Show 11 findings</summary>");
    expect(renderComment(input({ flags: many.slice(0, 10) }))).not.toContain("<details>");
  });

  it("caps the number of rows and says how many were left out", () => {
    const flood = Array.from({ length: 40 }, (_, i) => flag({ file: `f${i}.ts` }));
    const out = renderComment(input({ flags: flood }));
    expect(out).toContain("### ⚠️ Automated checks (40)");
    expect(count(out, "| 🟠 high |")).toBe(25);
    expect(out).toContain("…and 15 more findings not shown.");
    expect(out).toContain("`f24.ts`");
    expect(out).not.toContain("`f25.ts`");
  });
});

describe("renderComment: AI sections and reviewers", () => {
  it("renders risks in a table and tests as a list", () => {
    const out = renderComment(
      input({
        summary: {
          status: "ok",
          result: reviewResult({
            risks: [{ file: "src/a.ts", reason: "Race | condition", severity: "high" }],
            testingSuggestions: ["Test A", "Test B"],
          }),
        },
      }),
    );
    expect(out).toContain("| 🟠 high | `src/a.ts` | Race \\| condition |");
    expect(out).toContain("- Test A\n- Test B");
  });

  it("shows reviewers as code, not @mentions, so nobody is notified", () => {
    const out = renderComment(input({ reviewers: [alice, platform] }));
    expect(out).toContain("- `@alice`: owns 2 changed files (CODEOWNERS)");
    expect(out).toContain("- `@acme/platform`: owns 1 changed file (CODEOWNERS)");
    expect(out.replace(/`[^`]*`/g, "")).not.toMatch(/@[A-Za-z]/); // no @ outside code spans
  });
});

describe("renderComment: hostile input cannot escape into the comment", () => {
  const hostile = [
    `${MARKER} <script>alert(1)</script> ![x](https://evil.test/p.png) [free money](https://evil.test)`,
    "cc @octocat @acme/platform @everyone, fixes #1",
    "```\nunterminated fence",
  ].join("\n");

  const out = renderComment(
    input({
      flags: [flag({ file: `src/${MARKER}.ts`, reason: hostile })],
      summary: {
        status: "ok",
        result: reviewResult({
          summary: hostile,
          keyChanges: [hostile],
          risks: [{ file: hostile, reason: hostile, severity: "high" }],
          testingSuggestions: [hostile],
        }),
      },
      configWarning: hostile,
    }),
  );

  it("contains the marker exactly once, ours", () => {
    expect(count(out, MARKER)).toBe(1);
    expect(out.startsWith(MARKER)).toBe(true);
  });

  // Inside a code span markdown shows everything literally (no mentions, links or HTML), so the
  // checks about rendering look at the text outside code spans.
  const prose = out.replace(/`[^`\n]*`/g, "``");

  it("contains no HTML other than our own structural tags (code spans included)", () => {
    const withoutOurs = out.replace(MARKER, "").replaceAll("<sub>", "").replaceAll("</sub>", "");
    expect(withoutOurs).not.toContain("<");
  });

  it("notifies nobody and creates no cross-references", () => {
    expect(prose).not.toMatch(/@[A-Za-z0-9_]/);
    expect(prose).not.toMatch(/#\d/);
  });

  it("contains no live links or images, and no code fences", () => {
    expect(prose).not.toMatch(/(?<!\\)\]\(/);
    expect(prose).not.toMatch(/(?<!\\)!\[/);
    expect(out).not.toContain("```");
  });
});

describe("renderComment: size limit", () => {
  it("never exceeds the limit and keeps the marker, even for absurd input", () => {
    const risks = Array.from({ length: 800 }, (_, i) => ({ file: `f${i}.ts`, reason: "r".repeat(500), severity: "low" as const }));
    const out = renderComment(input({ summary: { status: "ok", result: reviewResult({ risks }) } }));
    expect(out.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(out.startsWith(MARKER)).toBe(true);
    expect(out).toContain("comment truncated");
  });
});

const GOLDEN = `<!-- pr-pilot:review -->
## 🤖 PR Pilot review

> [!CAUTION]
> **1 critical finding.** See the automated checks below. If a credential was committed, rotate it: deleting it from this PR does not remove it from git history.

### Summary
Adds audit logging to the login flow.

**Key changes**
- Writes an audit entry on every login

### 🔎 Risks noted by the AI reviewer
| Severity | File | Risk |
| --- | --- | --- |
| 🟡 medium | \`src/auth/login.ts\` | Audit write is not awaited |

### 🧪 Suggested tests
- Verify a failed login is also audited

### ⚠️ Automated checks (2)

| Severity | Where | Finding |
| --- | --- | --- |
| 🔴 critical | \`src/config.ts:12\` | Likely AWS access key ID added |
| 🟠 high | \`src/auth/login.ts\` | Touches security-sensitive code (matches **/auth/**) |

### 👥 Suggested reviewers
- \`@alice\`: owns 2 changed files (CODEOWNERS)
- \`@acme/platform\`: owns 1 changed file (CODEOWNERS)

---
<sub>Reviewed commit \`abcdef0\`. This comment is updated automatically on each push.</sub>
`;
