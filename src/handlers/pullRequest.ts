import { z } from "zod";
import type { GithubClient } from "../github.js";
import type { SummarizeFn, SummaryResult } from "../llm/summarize.js";
import { logger } from "../logger.js";
import { CONFIG_PATH, parseRiskConfig } from "../risk/config.js";
import { scanDiff } from "../risk/scan.js";

// Only the fields we use. zod strips the rest and rejects malformed payloads.
const pullRequestPayload = z.object({
  action: z.string(),
  number: z.number(),
  installation: z.object({ id: z.number() }).optional(),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
  pull_request: z.object({
    title: z.string(),
    body: z.string().nullish(),
    user: z.object({ login: z.string() }),
    base: z.object({ sha: z.string() }),
  }),
});

const HANDLED_ACTIONS = new Set(["opened", "synchronize"]);

type Deps = Pick<GithubClient, "getPullRequestDiff" | "getFileContent"> & {
  /** Absent when no LLM API key is configured. */
  summarize?: SummarizeFn;
};

export async function handlePullRequest(payload: unknown, deps: Deps): Promise<void> {
  const parsed = pullRequestPayload.safeParse(payload);
  if (!parsed.success) {
    logger.warn("Unexpected pull_request payload shape", { issues: parsed.error.issues.length });
    return;
  }
  const { action, number, installation, repository, pull_request } = parsed.data;

  if (!HANDLED_ACTIONS.has(action)) return;
  if (!installation) {
    logger.warn("pull_request event had no installation id", { number });
    return;
  }

  const owner = repository.owner.login;
  const repo = repository.name;

  const diff = await deps.getPullRequestDiff(installation.id, owner, repo, number);

  // Read the config from the BASE commit (the target branch), never from the PR's own code.
  // Otherwise a PR could add `ignore: ["src/auth/**"]` to hide its own risky changes.
  let configText: string | null = null;
  try {
    configText = await deps.getFileContent(
      installation.id,
      owner,
      repo,
      CONFIG_PATH,
      pull_request.base.sha,
    );
  } catch (err) {
    logger.warn(`Could not read ${CONFIG_PATH}; using defaults`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const { config, warning } = parseRiskConfig(configText);
  if (warning) logger.warn("Invalid review configuration", { repo: `${owner}/${repo}`, warning });

  // Deterministic rules run first: cheap, instant, and they never depend on the LLM being up.
  const flags = scanDiff(diff, config);

  logger.info("Pull request received", {
    repo: `${owner}/${repo}`,
    pr: number,
    action,
    author: pull_request.user.login,
    changedFiles: diff.files.map((f) => f.path),
    additions: diff.files.reduce((sum, f) => sum + f.additions, 0),
    deletions: diff.files.reduce((sum, f) => sum + f.deletions, 0),
    truncated: diff.truncated,
    flagCount: flags.length,
    flags,
  });

  if (!deps.summarize) return;

  let result: SummaryResult;
  try {
    result = await deps.summarize({ title: pull_request.title, body: pull_request.body, diff, flags });
  } catch (err) {
    // The rule-based findings above already stand on their own; an LLM outage must not hide them.
    logger.warn("LLM summary failed; continuing with rule-based findings only", {
      pr: number,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  logger.info("LLM summary", {
    pr: number,
    mode: result.mode,
    calls: result.calls,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    review: result.summary,
  });
}
