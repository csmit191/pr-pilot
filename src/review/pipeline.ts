import type { PullRequestDiff } from "../diff/types.js";
import type { GithubClient } from "../github.js";
import type { SummarizeFn, SummaryResult } from "../llm/summarize.js";
import { logger } from "../logger.js";
import { suggestReviewers, type SuggestOutcome } from "../reviewers/suggest.js";
import { CONFIG_PATH, parseRiskConfig } from "../risk/config.js";
import { scanDiff } from "../risk/scan.js";
import type { RiskFlag } from "../risk/types.js";

export interface ReviewContext {
  installationId: number;
  owner: string;
  repo: string;
  number: number;
  /** The webhook action ("opened", "synchronize"), only used for logging. */
  action: string;
  title: string;
  body: string | null | undefined;
  author: string;
  /** Commit SHA of the PR's base: config, CODEOWNERS and history are read as of this point. */
  baseSha: string;
}

export type SummaryOutcome =
  | { status: "disabled" } // no LLM configured
  | { status: "failed"; error: string }
  | { status: "ok"; result: SummaryResult };

export interface ReviewResult {
  diff: PullRequestDiff;
  flags: RiskFlag[];
  /** Set when .prpilot.yml was present but unusable and defaults were used. */
  configWarning: string | undefined;
  summary: SummaryOutcome;
  /** null if the reviewer lookup itself failed unexpectedly. */
  reviewers: SuggestOutcome | null;
  durationMs: number;
}

export type PipelineDeps = Pick<
  GithubClient,
  "getPullRequestDiff" | "getFileContent" | "getFileHistory"
> & {
  /** Absent when no LLM API key is configured. */
  summarize?: SummarizeFn;
};

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Everything that happens between "a PR changed" and "here is what we think": fetch the diff,
 * run the deterministic rules, then (in parallel) the LLM summary and the reviewer lookup.
 * It never posts anything, so it can be reused by the evaluation script.
 *
 * It throws only if the diff itself can't be fetched. An LLM or reviewer failure is reported
 * in the result instead, so the rule-based findings are never lost.
 */
export async function runReview(ctx: ReviewContext, deps: PipelineDeps): Promise<ReviewResult> {
  const startedAt = Date.now();
  const { installationId, owner, repo, number } = ctx;

  const diff = await deps.getPullRequestDiff(installationId, owner, repo, number);

  // Read the config from the BASE commit (the target branch), never from the PR's own code.
  // Otherwise a PR could add `ignore: ["src/auth/**"]` to hide its own risky changes.
  let configText: string | null = null;
  try {
    configText = await deps.getFileContent(installationId, owner, repo, CONFIG_PATH, ctx.baseSha);
  } catch (err) {
    logger.warn(`Could not read ${CONFIG_PATH}; using defaults`, { error: errorMessage(err) });
  }

  const { config, warning } = parseRiskConfig(configText);
  if (warning) logger.warn("Invalid review configuration", { repo: `${owner}/${repo}`, warning });

  // Deterministic rules run first: cheap, instant, and they never depend on the LLM being up.
  const flags = scanDiff(diff, config);

  logger.info("Pull request received", {
    repo: `${owner}/${repo}`,
    pr: number,
    action: ctx.action,
    author: ctx.author,
    changedFiles: diff.files.map((f) => f.path),
    additions: diff.files.reduce((sum, f) => sum + f.additions, 0),
    deletions: diff.files.reduce((sum, f) => sum + f.deletions, 0),
    truncated: diff.truncated,
    flagCount: flags.length,
    flags,
  });

  // Reviewer lookup (GitHub API) and the LLM summary (provider API) don't depend on each other,
  // so they run at the same time. Neither is allowed to fail the whole review.
  const findReviewers = async (): Promise<SuggestOutcome | null> => {
    try {
      const outcome = await suggestReviewers(
        { installationId, owner, repo, baseSha: ctx.baseSha, author: ctx.author, files: diff.files },
        deps,
      );
      logger.info("Reviewer suggestions", {
        pr: number,
        codeowners: outcome.codeownersPath,
        historyFilesChecked: outcome.historyFilesChecked,
        historyFailures: outcome.historyFailures,
        reviewers: outcome.reviewers,
      });
      return outcome;
    } catch (err) {
      logger.warn("Reviewer suggestion failed", { pr: number, error: errorMessage(err) });
      return null;
    }
  };

  const summarizeChange = async (): Promise<SummaryOutcome> => {
    if (!deps.summarize) return { status: "disabled" };
    try {
      const result = await deps.summarize({ title: ctx.title, body: ctx.body, diff, flags });
      logger.info("LLM summary", {
        pr: number,
        mode: result.mode,
        calls: result.calls,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        review: result.summary,
      });
      return { status: "ok", result };
    } catch (err) {
      // The rule-based findings already stand on their own; an LLM outage must not hide them.
      logger.warn("LLM summary failed; continuing with rule-based findings only", {
        pr: number,
        error: errorMessage(err),
      });
      return { status: "failed", error: errorMessage(err) };
    }
  };

  const [reviewers, summary] = await Promise.all([findReviewers(), summarizeChange()]);

  return { diff, flags, configWarning: warning, summary, reviewers, durationMs: Date.now() - startedAt };
}
