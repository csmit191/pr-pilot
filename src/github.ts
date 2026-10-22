import { App } from "octokit";
import type { Config } from "./config.js";
import { fetchPullRequestDiff } from "./diff/fetch.js";
import type { PullRequestDiff } from "./diff/types.js";
import { parseCommitHistory, type CommitInfo } from "./reviewers/history.js";

export interface GithubClient {
  getPullRequestDiff(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<PullRequestDiff>;
  /** Returns the file's text at `ref`, or null if it doesn't exist there. */
  getFileContent(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null>;
  /** The most recent commits (newest first) that touched `path`, starting from `ref`. */
  getFileHistory(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref: string,
    since: string,
  ): Promise<CommitInfo[]>;
}

export function createGithubClient(config: Pick<Config, "appId" | "privateKey">): GithubClient {
  // App signs a short-lived JWT with the private key, then trades it for an
  // installation token scoped to the repos where the app is installed.
  const app = new App({ appId: config.appId, privateKey: config.privateKey });

  return {
    async getPullRequestDiff(installationId, owner, repo, pullNumber) {
      const octokit = await app.getInstallationOctokit(installationId);
      return fetchPullRequestDiff(async (page, perPage) => {
        const { data } = await octokit.rest.pulls.listFiles({
          owner,
          repo,
          pull_number: pullNumber,
          per_page: perPage,
          page,
        });
        return data;
      });
    },

    async getFileContent(installationId, owner, repo, path, ref) {
      const octokit = await app.getInstallationOctokit(installationId);
      try {
        const { data } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path,
          ref,
          mediaType: { format: "raw" }, // return the file body as text, not base64 JSON
        });
        return typeof data === "string" ? data : null;
      } catch (err) {
        if (typeof err === "object" && err !== null && "status" in err && err.status === 404) {
          return null; // file simply doesn't exist
        }
        throw err; // 403 (missing permission), 5xx, network: let the caller decide
      }
    },

    async getFileHistory(installationId, owner, repo, path, ref, since) {
      const octokit = await app.getInstallationOctokit(installationId);
      const { data } = await octokit.rest.repos.listCommits({
        owner,
        repo,
        path,
        sha: ref,
        since,
        per_page: 10,
      });
      return parseCommitHistory(data); // validated here, so Octokit's union types don't leak out
    },
  };
}
