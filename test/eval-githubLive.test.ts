import { describe, expect, it } from "vitest";
import { GitHubApiError, createLiveGithub } from "../src/eval/githubLive.js";

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(respond: (url: string) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return respond(String(url));
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const metaBody = {
  title: "Fix login",
  body: null,
  user: { login: "octocat" },
  base: { sha: "base111" },
  head: { sha: "head222" },
  merged: true,
  merged_at: "2026-09-01T10:00:00Z",
};

describe("createLiveGithub: pull request metadata", () => {
  it("reads the metadata of a merged PR", async () => {
    const f = fakeFetch(() => json(metaBody));
    const meta = await createLiveGithub({ fetch: f.fetch }).getPullRequestMeta("acme", "widgets", 5);
    expect(f.calls[0]?.url).toBe("https://api.github.com/repos/acme/widgets/pulls/5");
    expect(meta).toEqual({ title: "Fix login", body: null, author: "octocat", baseSha: "base111", headSha: "head222", merged: true, mergedAt: "2026-09-01T10:00:00Z" });
  });

  it("treats a missing 'merged' field as not merged", async () => {
    const { title, body, user, base, head } = metaBody;
    const f = fakeFetch(() => json({ title, body, user, base, head })); // no merged / merged_at
    const meta = await createLiveGithub({ fetch: f.fetch }).getPullRequestMeta("acme", "widgets", 5);
    expect(meta).toMatchObject({ merged: false, mergedAt: null });
  });

  it("sends the headers GitHub requires, and the token only when there is one", async () => {
    const anonymous = fakeFetch(() => json(metaBody));
    await createLiveGithub({ fetch: anonymous.fetch }).getPullRequestMeta("a", "b", 1);
    expect(anonymous.calls[0]?.headers).toEqual({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "pr-pilot-eval",
    });

    const authed = fakeFetch(() => json(metaBody));
    await createLiveGithub({ fetch: authed.fetch, token: "tok_123" }).getPullRequestMeta("a", "b", 1);
    expect(authed.calls[0]?.headers.authorization).toBe("Bearer tok_123");
  });

  it("raises GitHubApiError for a missing PR", async () => {
    const f = fakeFetch(() => json({ message: "Not Found" }, 404));
    const err = await createLiveGithub({ fetch: f.fetch }).getPullRequestMeta("a", "b", 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).status).toBe(404);
  });
});

describe("createLiveGithub: errors", () => {
  it("reports other failures with the status and path, never the token", async () => {
    const f = fakeFetch(() => json({ message: "boom" }, 500));
    const err = (await createLiveGithub({ fetch: f.fetch, token: "secret-token-value" }).getPullRequestMeta("a", "b", 1).catch((e: unknown) => e)) as GitHubApiError;
    expect(err.status).toBe(500);
    expect(err.message).toContain("/repos/a/b/pulls/1");
    expect(err.message).not.toContain("secret-token-value");
  });

  it.each([403, 429])("explains an exhausted rate limit (HTTP %s)", async (status) => {
    const f = fakeFetch(() => json({ message: "rate limited" }, status, { "x-ratelimit-remaining": "0" }));
    await expect(createLiveGithub({ fetch: f.fetch }).getPullRequestMeta("a", "b", 1)).rejects.toThrow("set GITHUB_TOKEN");
  });

  it("does not blame the rate limit for an ordinary 403", async () => {
    const f = fakeFetch(() => json({ message: "forbidden" }, 403, { "x-ratelimit-remaining": "42" }));
    const err = (await createLiveGithub({ fetch: f.fetch }).getPullRequestMeta("a", "b", 1).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("GITHUB_TOKEN");
  });
});

describe("createLiveGithub: diff", () => {
  const file = (i: number) => ({ filename: `f${i}.ts`, status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@" });

  it("follows pagination across pages", async () => {
    const f = fakeFetch((url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return json(page === 1 ? Array.from({ length: 100 }, (_, i) => file(i)) : [file(100), file(101)]);
    });
    const diff = await createLiveGithub({ fetch: f.fetch }).getPullRequestDiff(0, "acme", "widgets", 5);
    expect(diff.files).toHaveLength(102);
    expect(diff.truncated).toBe(false);
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/widgets/pulls/5/files?per_page=100&page=1",
      "https://api.github.com/repos/acme/widgets/pulls/5/files?per_page=100&page=2",
    ]);
  });

  it("rejects a response that is not a list", async () => {
    const f = fakeFetch(() => json({ message: "weird" }));
    await expect(createLiveGithub({ fetch: f.fetch }).getPullRequestDiff(0, "a", "b", 1)).rejects.toThrow("Unexpected");
  });
});

describe("createLiveGithub: file content", () => {
  it("asks for the raw text at a ref and encodes each path segment", async () => {
    const f = fakeFetch(() => new Response("* @alice\n", { status: 200 }));
    const text = await createLiveGithub({ fetch: f.fetch }).getFileContent(0, "acme", "widgets", "docs/a b/CODEOWNERS", "abc/123");
    expect(text).toBe("* @alice\n");
    expect(f.calls[0]?.url).toBe("https://api.github.com/repos/acme/widgets/contents/docs/a%20b/CODEOWNERS?ref=abc%2F123");
    expect(f.calls[0]?.headers.accept).toBe("application/vnd.github.raw+json");
  });

  it("returns null when the file doesn't exist", async () => {
    const f = fakeFetch(() => json({ message: "Not Found" }, 404));
    expect(await createLiveGithub({ fetch: f.fetch }).getFileContent(0, "a", "b", ".prpilot.yml", "x")).toBeNull();
  });

  it("raises on other failures", async () => {
    const f = fakeFetch(() => json({}, 500));
    await expect(createLiveGithub({ fetch: f.fetch }).getFileContent(0, "a", "b", "x", "y")).rejects.toBeInstanceOf(GitHubApiError);
  });
});

describe("createLiveGithub: file history", () => {
  it("queries the commits endpoint and parses the answer", async () => {
    const f = fakeFetch(() =>
      json([{ sha: "a".repeat(40), author: { login: "alice", type: "User" }, commit: { author: { date: "2026-10-01T12:00:00Z" } } }]),
    );
    const commits = await createLiveGithub({ fetch: f.fetch }).getFileHistory(0, "acme", "widgets", "src/a b.ts", "base111", "2025-10-22T00:00:00.000Z");
    expect(commits).toEqual([{ authorLogin: "alice", authorIsBot: false, date: "2026-10-01T12:00:00Z" }]);

    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/repos/acme/widgets/commits");
    expect(Object.fromEntries(url.searchParams)).toEqual({ path: "src/a b.ts", sha: "base111", since: "2025-10-22T00:00:00.000Z", per_page: "10" });
  });
});
