import type { Dataset, Judgments, RunResults } from "./types.js";

const where = (file: string | undefined, line: number | undefined): string =>
  file === undefined ? "whole PR" : line === undefined ? file : `${file}:${line}`;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * A read-only sheet to keep open while you fill in judgments.json: for each PR, your labels and
 * the tool's findings with the ids you need to type, and what has been decided so far.
 */
export function renderJudgingGuide(dataset: Dataset, results: RunResults, judgments: Judgments): string {
  const lines: string[] = [
    "# Judging guide",
    "",
    "Edit `judgments.json` next to this file. For each PR:",
    "",
    "- **Findings**: set each to `true` if a careful reviewer would agree it deserves attention (even if you did not label it), or `false` if it is noise or wrong.",
    '- **Labels**: set each to the id of the finding that caught it (e.g. `"l0"`), or `"none"` if the tool missed it.',
    "- `null` means not decided yet. Items already filled in were matched automatically (same rule, same file).",
    "",
  ];

  for (const entry of dataset.prs) {
    if (entry.status !== "labeled") continue;
    const result = results.prs.find((r) => r.id === entry.id);
    if (!result) continue;
    const verdicts = judgments.prs[entry.id];

    lines.push(`## ${entry.id}: ${oneLine(entry.title)}`, "", entry.url, "", "**Your labeled risks**", "");
    if (entry.labels.length === 0) lines.push("_none (a clean PR: every flag below is a false alarm unless you decide otherwise)_");
    entry.labels.forEach((label, index) => {
      const verdict = verdicts?.labels[String(index)];
      const state = verdict === undefined || verdict === null ? "TO DECIDE" : verdict === "none" ? "missed" : `caught by ${verdict}`;
      lines.push(`- label ${index} [${label.category}] ${where(label.file, undefined)}: ${oneLine(label.description)} → **${state}**`);
    });

    lines.push("", "**What the tool reported**", "");
    if (result.findings.length === 0) lines.push("_nothing_");
    for (const finding of result.findings) {
      const verdict = verdicts?.findings[finding.id];
      const state = verdict === undefined || verdict === null ? "TO DECIDE" : verdict ? "reasonable" : "noise";
      lines.push(`- ${finding.id} [${finding.source}, ${finding.severity}] ${where(finding.file, finding.line)}: ${oneLine(finding.text)} → **${state}**`);
    }
    if (result.summary.text) lines.push("", `_LLM summary:_ ${oneLine(result.summary.text)}`);
    lines.push("");
  }
  return lines.join("\n");
}
