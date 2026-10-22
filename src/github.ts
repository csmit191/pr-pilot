import { App } from "octokit";
import type { Config } from "./config.js";

export interface GithubClient {
  listChangedFiles(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<string[]>;
}

export function createGithubClient(config: Pick<Config, "appId" | "privateKey">): GithubClient {
  // App signs a short-lived JWT with the private key, then trades it for an
  // installation token scoped to the repos where the app is installed.
  const app = new App({ appId: config.appId, privateKey: config.privateKey });

  return {
    async listChangedFiles(installationId, owner, repo, pullNumber) {
      const octokit = await app.getInstallationOctokit(installationId);
      // paginate() follows Link headers; the API returns at most 100 files per page
      // (and caps at 3000 files total per PR).
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });
      return files.map((f) => f.filename);
    },
  };
}
