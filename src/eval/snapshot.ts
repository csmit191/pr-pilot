import type { PullRequestDiff } from "../diff/types.js";
import type { GithubClient } from "../github.js";
import type { CommitInfo } from "../reviewers/history.js";

type ReviewGithub = Pick<GithubClient, "getPullRequestDiff" | "getFileContent" | "getFileHistory">;

export interface Recording {
  diff: PullRequestDiff | null;
  files: Record<string, string | null>;
  history: Record<string, CommitInfo[]>;
}

export interface Recorder {
  deps: ReviewGithub;
  recording(): Recording;
}

/**
 * Wraps real GitHub access and remembers every answer, so the same PR can be replayed later
 * without the network. Maps (not plain objects) hold the data: a file literally named
 * "__proto__" must not be able to touch an object's prototype.
 */
export function createRecorder(inner: ReviewGithub): Recorder {
  let diff: PullRequestDiff | null = null;
  const files = new Map<string, string | null>();
  const history = new Map<string, CommitInfo[]>();

  return {
    deps: {
      async getPullRequestDiff(...args) {
        diff = await inner.getPullRequestDiff(...args);
        return diff;
      },
      async getFileContent(...args) {
        const text = await inner.getFileContent(...args);
        files.set(args[3], text);
        return text;
      },
      async getFileHistory(...args) {
        const commits = await inner.getFileHistory(...args);
        history.set(args[3], commits);
        return commits;
      },
    },
    recording: () => ({ diff, files: Object.fromEntries(files), history: Object.fromEntries(history) }),
  };
}

interface Replayable {
  diff: PullRequestDiff;
  files: Record<string, string | null>;
  history: Record<string, CommitInfo[]>;
}

/** Answers the pipeline's GitHub questions from a snapshot instead of the network. */
export function createReplayDeps(snapshot: Replayable): ReviewGithub {
  const files = new Map(Object.entries(snapshot.files));
  const history = new Map(Object.entries(snapshot.history));
  return {
    getPullRequestDiff: async () => snapshot.diff,
    getFileContent: async (_installationId, _owner, _repo, path) => files.get(path) ?? null,
    getFileHistory: async (_installationId, _owner, _repo, path) => history.get(path) ?? [],
  };
}
