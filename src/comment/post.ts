import type { GithubClient } from "../github.js";
import { httpStatus } from "../util/http.js";
import type { ExistingComment } from "./existing.js";
import { MARKER } from "./render.js";

export type PostDeps = Pick<GithubClient, "listIssueCommentsPage" | "createIssueComment" | "updateIssueComment">;

export interface PostTarget {
  installationId: number;
  owner: string;
  repo: string;
  /** A pull request's comment thread is the thread of the issue with the same number. */
  pullNumber: number;
  /** Our GitHub App's id: only comments posted by it are ever treated as ours. */
  appId: number;
}

export type PostResult = { action: "created" | "updated" | "unchanged"; commentId: number };

const PAGE_SIZE = 100;
const MAX_PAGES = 10; // 1000 comments; a review comment is normally one of the first

/**
 * Finds our comment on the PR. A comment counts only if it carries the marker AND was posted by
 * our app: otherwise anyone could paste the marker into their own comment and confuse us.
 */
export async function findOurComment(
  target: PostTarget,
  deps: Pick<PostDeps, "listIssueCommentsPage">,
): Promise<ExistingComment | null> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const comments = await deps.listIssueCommentsPage(
      target.installationId,
      target.owner,
      target.repo,
      target.pullNumber,
      page,
      PAGE_SIZE,
    );
    const ours = comments.find((c) => c.appId === target.appId && c.body.trimStart().startsWith(MARKER));
    if (ours) return ours;
    if (comments.length < PAGE_SIZE) return null;
  }
  return null;
}

const normalize = (text: string): string => text.replace(/\r\n/g, "\n").trim();

/** Edits our existing comment, or posts a new one. Leaves the comment alone if nothing changed. */
export async function upsertReviewComment(target: PostTarget, body: string, deps: PostDeps): Promise<PostResult> {
  const { installationId, owner, repo, pullNumber } = target;
  const existing = await findOurComment(target, deps);

  if (existing) {
    if (normalize(existing.body) === normalize(body)) return { action: "unchanged", commentId: existing.id };
    try {
      await deps.updateIssueComment(installationId, owner, repo, existing.id, body);
      return { action: "updated", commentId: existing.id };
    } catch (err) {
      if (httpStatus(err) !== 404) throw err;
      // Someone deleted our comment between listing and editing it: post a fresh one below.
    }
  }

  const commentId = await deps.createIssueComment(installationId, owner, repo, pullNumber, body);
  return { action: "created", commentId };
}
