import type { ChangedFile } from "../diff/types.js";
import type { GithubClient } from "../github.js";
import { isLockfile } from "../risk/rules/dependencies.js";
import { mapWithLimit } from "../util/concurrency.js";
import { CODEOWNERS_LOCATIONS, parseCodeowners, type CodeownersRule } from "./codeowners.js";
import type { CommitInfo } from "./history.js";
import { scoreReviewers, type ReviewerSuggestion } from "./score.js";

export const MAX_HISTORY_FILES = 8;
export const HISTORY_WINDOW_DAYS = 365;
const HISTORY_CONCURRENCY = 4;

export interface SuggestContext {
  installationId: number;
  owner: string;
  repo: string;
  /** Commit SHA of the PR's base: CODEOWNERS and history are read as of this point. */
  baseSha: string;
  author: string;
  files: readonly ChangedFile[];
}

export type SuggestDeps = Pick<GithubClient, "getFileContent" | "getFileHistory">;

export interface SuggestOutcome {
  reviewers: ReviewerSuggestion[];
  /** Which CODEOWNERS file was used, or null if the repo has none. */
  codeownersPath: string | null;
  historyFilesChecked: number;
  /** History lookups that failed; those files simply contribute nothing. */
  historyFailures: number;
}

/** Fetches CODEOWNERS and recent history from GitHub, then scores. Never throws for API problems. */
export async function suggestReviewers(
  ctx: SuggestContext,
  deps: SuggestDeps,
  options: { now?: Date; maxHistoryFiles?: number } = {},
): Promise<SuggestOutcome> {
  const now = options.now ?? new Date();
  const maxHistoryFiles = options.maxHistoryFiles ?? MAX_HISTORY_FILES;
  const { installationId, owner, repo, baseSha } = ctx;

  // CODEOWNERS: from the BASE commit, the same version GitHub itself uses for review requests.
  let rules: CodeownersRule[] = [];
  let codeownersPath: string | null = null;
  for (const location of CODEOWNERS_LOCATIONS) {
    try {
      const text = await deps.getFileContent(installationId, owner, repo, location, baseSha);
      if (text !== null) {
        rules = parseCodeowners(text);
        codeownersPath = location;
        break;
      }
    } catch {
      // Unreadable (permissions, outage): treat like missing and try the next location.
    }
  }

  // History: only for files where it's informative and affordable.
  const worthChecking = ctx.files
    .filter((file) => file.status !== "added" && !isLockfile(file.path))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path))
    .slice(0, maxHistoryFiles);

  const since = new Date(now.getTime() - HISTORY_WINDOW_DAYS * 86_400_000).toISOString();
  let historyFailures = 0;

  const results = await mapWithLimit(worthChecking, HISTORY_CONCURRENCY, async (file) => {
    // For a rename, the useful history lives under the old name.
    const queryPath = file.status === "renamed" && file.previousPath ? file.previousPath : file.path;
    try {
      const commits = await deps.getFileHistory(installationId, owner, repo, queryPath, baseSha, since);
      return { path: file.path, commits };
    } catch {
      historyFailures++;
      return { path: file.path, commits: [] as CommitInfo[] };
    }
  });

  const history = new Map<string, CommitInfo[]>(results.map((r) => [r.path, r.commits]));
  const reviewers = scoreReviewers({ author: ctx.author, files: ctx.files, rules, history, now });

  return { reviewers, codeownersPath, historyFilesChecked: worthChecking.length, historyFailures };
}
