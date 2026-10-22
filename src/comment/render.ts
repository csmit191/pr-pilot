import type { ReviewerSuggestion } from "../reviewers/score.js";
import type { SummaryOutcome } from "../review/pipeline.js";
import type { RiskFlag, Severity } from "../risk/types.js";
import { cell, code, inline } from "./sanitize.js";

/**
 * First line of every comment we post. It's invisible when rendered, and lets later pushes find
 * and edit the same comment. Untrusted text can't contain it ("<" is always escaped), and we
 * only trust a marker on a comment posted by our own app (see post.ts).
 */
export const MARKER = "<!-- pr-pilot:review -->";

/** GitHub rejects comments over 65,536 characters; stay comfortably below. */
export const MAX_COMMENT_CHARS = 60_000;

const BADGE: Record<Severity, string> = {
  critical: "🔴 critical",
  high: "🟠 high",
  medium: "🟡 medium",
  low: "🔵 low",
};

/** Beyond this many rows the findings table is collapsed into a <details> block. */
const COLLAPSE_AFTER = 10;
const FLAG_LIMITS = [25, 10, 3, 0];

export interface RenderInput {
  flags: RiskFlag[];
  summary: SummaryOutcome;
  reviewers: ReviewerSuggestion[];
  configWarning?: string | undefined;
  /** Head commit of the PR that was reviewed. */
  headSha: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function renderFlagsSection(flags: RiskFlag[], maxRows: number): string {
  if (flags.length === 0) {
    return "### ✅ Automated checks\nNo risky changes were detected by the rule-based checks.";
  }

  const shown = flags.slice(0, maxRows);
  const lines = [`### ⚠️ Automated checks (${flags.length})`];

  if (shown.length === 0) {
    lines.push(`${plural(flags.length, "finding")} not shown here because the comment would be too long. See the PR Pilot logs.`);
    return lines.join("\n");
  }

  const table = [
    "| Severity | Where | Finding |",
    "| --- | --- | --- |",
    ...shown.map((flag) => {
      const where = flag.file ? code(flag.line ? `${flag.file}:${flag.line}` : flag.file) : "Whole PR";
      return `| ${BADGE[flag.severity]} | ${where} | ${cell(flag.reason)} |`;
    }),
  ].join("\n");

  lines.push(shown.length > COLLAPSE_AFTER ? `<details>\n<summary>Show ${shown.length} findings</summary>\n\n${table}\n\n</details>` : table);
  if (flags.length > shown.length) lines.push(`…and ${plural(flags.length - shown.length, "more finding")} not shown.`);
  return lines.join("\n\n");
}

function renderSummarySection(summary: SummaryOutcome): string[] {
  if (summary.status === "disabled") return [];
  if (summary.status === "failed") {
    return ["> [!NOTE]\n> The AI summary was unavailable for this run, so only the automated checks and reviewer suggestions are shown."];
  }

  const review = summary.result.summary;
  const sections = [`### Summary\n${inline(review.summary, 1500)}`];

  if (review.keyChanges.length > 0) {
    sections.push(`**Key changes**\n${review.keyChanges.map((c) => `- ${inline(c)}`).join("\n")}`);
  }
  if (review.risks.length > 0) {
    const rows = review.risks.map((r) => `| ${BADGE[r.severity]} | ${code(r.file)} | ${cell(r.reason, 500)} |`);
    sections.push(`### 🔎 Risks noted by the AI reviewer\n${["| Severity | File | Risk |", "| --- | --- | --- |", ...rows].join("\n")}`);
  }
  if (review.testingSuggestions.length > 0) {
    sections.push(`### 🧪 Suggested tests\n${review.testingSuggestions.map((t) => `- ${inline(t)}`).join("\n")}`);
  }
  return sections;
}

function renderReviewers(reviewers: ReviewerSuggestion[]): string[] {
  if (reviewers.length === 0) return [];
  // Handles are shown as code, not @mentions: suggesting someone shouldn't notify them on every push.
  const items = reviewers.map((r) => `- ${code(`@${r.handle}`)}: ${inline(r.reasons.join("; "))}`);
  return [`### 👥 Suggested reviewers\n${items.join("\n")}`];
}

function build(input: RenderInput, maxFlagRows: number): string {
  const sections: string[] = [`${MARKER}\n## 🤖 PR Pilot review`];

  const critical = input.flags.filter((f) => f.severity === "critical");
  if (critical.length > 0) {
    const advice = critical.some((f) => f.rule === "secrets")
      ? " If a credential was committed, rotate it: deleting it from this PR does not remove it from git history."
      : "";
    sections.push(`> [!CAUTION]\n> **${plural(critical.length, "critical finding")}.** See the automated checks below.${advice}`);
  }
  if (input.configWarning) sections.push(`> [!WARNING]\n> ${inline(input.configWarning, 600)}`);

  sections.push(...renderSummarySection(input.summary));
  sections.push(renderFlagsSection(input.flags, maxFlagRows));
  sections.push(...renderReviewers(input.reviewers));

  const sha = /^[0-9a-f]{7,40}$/i.test(input.headSha) ? input.headSha.slice(0, 7) : "unknown";
  sections.push(`---\n<sub>Reviewed commit \`${sha}\`. This comment is updated automatically on each push.</sub>`);

  return `${sections.join("\n\n")}\n`;
}

/** Renders the single review comment. Always starts with MARKER and stays under GitHub's size limit. */
export function renderComment(input: RenderInput): string {
  for (const maxRows of FLAG_LIMITS) {
    const body = build(input, maxRows);
    if (body.length <= MAX_COMMENT_CHARS) return body;
  }
  // Practically unreachable (every section is size-capped), but a hard guarantee is cheap.
  const note = "\n\n_…comment truncated to fit GitHub's size limit._\n";
  return build(input, 0).slice(0, MAX_COMMENT_CHARS - note.length) + note;
}
