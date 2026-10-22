import { App } from "octokit";
import type { Config } from "./config.js";
import { fetchPullRequestDiff } from "./diff/fetch.js";
import type { PullRequestDiff } from "./diff/types.js";

export interface GithubClient {
  getPullRequestDiff(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<PullRequestDiff>;
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
  };
}
