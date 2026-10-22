import { z } from "zod";
import { fetchPullRequestDiff } from "../diff/fetch.js";
import type { GithubClient } from "../github.js";
import { parseCommitHistory } from "../reviewers/history.js";

export interface PrMeta {
  title: string;
  body: string | null;
  author: string;
  baseSha: string;
  headSha: string;
  merged: boolean;
  mergedAt: string | null;
}

/** The same calls the pipeline makes, but against any PUBLIC repo, using a personal token. */
export interface LiveGithub extends Pick<GithubClient, "getPullRequestDiff" | "getFileContent" | "getFileHistory"> {
  getPullRequestMeta(owner: string, repo: string, number: number): Promise<PrMeta>;
}

export interface LiveGithubOptions {
  /** A GitHub personal access token. Optional, but unauthenticated requests are limited to 60 per hour. */
  token?: string | undefined;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

const metaSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  user: z.object({ login: z.string() }),
  base: z.object({ sha: z.string() }),
  head: z.object({ sha: z.string() }),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
});

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

export function createLiveGithub(options: LiveGithubOptions = {}): LiveGithub {
  const baseUrl = options.baseUrl ?? "https://api.github.com";
  const fetchFn = options.fetch ?? fetch;

  async function request(path: string, accept = "application/vnd.github+json"): Promise<Response> {
    const headers: Record<string, string> = {
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": "pr-pilot-eval", // GitHub rejects API requests without a User-Agent
    };
    if (options.token) headers.authorization = `Bearer ${options.token}`;

    const response = await fetchFn(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (response.ok || response.status === 404) return response;

    const exhausted =
      (response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0";
    // Only the path (never the token) goes into the message.
    throw new GitHubApiError(
      `GitHub API ${response.status} for ${path.split("?")[0]}${exhausted ? " (rate limit exhausted; set GITHUB_TOKEN)" : ""}`,
      response.status,
    );
  }

  const getJson = async (path: string): Promise<unknown> => {
    const response = await request(path);
    if (response.status === 404) throw new GitHubApiError(`GitHub API 404 for ${path.split("?")[0]}`, 404);
    return response.json();
  };

  return {
    async getPullRequestMeta(owner, repo, number) {
      const parsed = metaSchema.parse(await getJson(`/repos/${owner}/${repo}/pulls/${number}`));
      return {
        title: parsed.title,
        body: parsed.body,
        author: parsed.user.login,
        baseSha: parsed.base.sha,
        headSha: parsed.head.sha,
        merged: parsed.merged ?? false,
        mergedAt: parsed.merged_at ?? null,
      };
    },

    getPullRequestDiff(_installationId, owner, repo, pullNumber) {
      return fetchPullRequestDiff((page, perPage) =>
        getJson(`/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=${perPage}&page=${page}`).then((data) => {
          if (!Array.isArray(data)) throw new Error("Unexpected pull request files response");
          return data;
        }),
      );
    },

    async getFileContent(_installationId, owner, repo, path, ref) {
      const response = await request(
        `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
        "application/vnd.github.raw+json",
      );
      return response.status === 404 ? null : response.text();
    },

    async getFileHistory(_installationId, owner, repo, path, ref, since) {
      const query = new URLSearchParams({ path, sha: ref, since, per_page: "10" });
      return parseCommitHistory(await getJson(`/repos/${owner}/${repo}/commits?${query.toString()}`));
    },
  };
}
