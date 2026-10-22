import { z } from "zod";
import { upsertReviewComment } from "../comment/post.js";
import { renderComment } from "../comment/render.js";
import type { GithubClient } from "../github.js";
import { logger } from "../logger.js";
import { runReview, type PipelineDeps } from "../review/pipeline.js";
import { createLatestWinsQueue, type LatestWinsQueue } from "../util/latestWins.js";
import { httpStatus } from "../util/http.js";

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
    head: z.object({ sha: z.string() }),
  }),
});

const HANDLED_ACTIONS = new Set(["opened", "synchronize"]);

type Deps = PipelineDeps &
  Pick<GithubClient, "listIssueCommentsPage" | "createIssueComment" | "updateIssueComment"> & {
    /** The id of our GitHub App, used to recognize our own comments. */
    appId: number;
    /** Injectable for tests; production uses one shared queue for the whole process. */
    queue?: LatestWinsQueue;
  };

const sharedQueue = createLatestWinsQueue();

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
  const queue = deps.queue ?? sharedQueue;

  // One review at a time per PR, and only the newest push gets to post. Two quick pushes would
  // otherwise race: duplicate comments, or an older review overwriting a newer one.
  const outcome = await queue.run(`${owner}/${repo}#${number}`, async (isSuperseded) => {
    const review = await runReview(
      {
        installationId: installation.id,
        owner,
        repo,
        number,
        action,
        title: pull_request.title,
        body: pull_request.body,
        author: pull_request.user.login,
        baseSha: pull_request.base.sha,
      },
      deps,
    );

    if (isSuperseded()) {
      logger.info("Not posting: a newer push is already being reviewed", { pr: number });
      return;
    }

    const body = renderComment({
      flags: review.flags,
      summary: review.summary,
      reviewers: review.reviewers?.reviewers ?? [],
      configWarning: review.configWarning,
      headSha: pull_request.head.sha,
    });

    try {
      const posted = await upsertReviewComment(
        { installationId: installation.id, owner, repo, pullNumber: number, appId: deps.appId },
        body,
        deps,
      );
      logger.info("Review comment posted", {
        pr: number,
        action: posted.action,
        commentId: posted.commentId,
        chars: body.length,
        reviewMs: review.durationMs,
      });
    } catch (err) {
      const status = httpStatus(err);
      logger.error("Failed to post review comment", {
        pr: number,
        status,
        error: err instanceof Error ? err.message : String(err),
        hint:
          status === 403 || status === 404
            ? "Check that the GitHub App has 'Pull requests: Read & write' permission and that the repo owner accepted it."
            : undefined,
      });
    }
  });

  if (outcome.skipped) logger.info("Skipped review: superseded by a newer push", { pr: number });
}
