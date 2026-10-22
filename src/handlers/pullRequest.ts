import { z } from "zod";
import type { GithubClient } from "../github.js";
import { logger } from "../logger.js";

// Only the fields we use. zod strips the rest and rejects malformed payloads.
const pullRequestPayload = z.object({
  action: z.string(),
  number: z.number(),
  installation: z.object({ id: z.number() }).optional(),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
  pull_request: z.object({ user: z.object({ login: z.string() }) }),
});

const HANDLED_ACTIONS = new Set(["opened", "synchronize"]);

export async function handlePullRequest(
  payload: unknown,
  deps: Pick<GithubClient, "listChangedFiles">,
): Promise<void> {
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

  const files = await deps.listChangedFiles(
    installation.id,
    repository.owner.login,
    repository.name,
    number,
  );

  logger.info("Pull request received", {
    repo: `${repository.owner.login}/${repository.name}`,
    pr: number,
    action,
    author: pull_request.user.login,
    changedFiles: files,
  });
}
