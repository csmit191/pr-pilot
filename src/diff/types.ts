/** Statuses GitHub reports for a file in a pull request. */
export const FILE_STATUSES = [
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
] as const;

export type FileStatus = (typeof FILE_STATUSES)[number];

export interface ChangedFile {
  path: string;
  /** Only set for renamed files: where the file used to live. */
  previousPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /**
   * The unified diff for this file. null when GitHub doesn't provide one:
   * binary files, pure renames, and diffs too large to include (e.g. lockfiles).
   * additions/deletions are still accurate in those cases.
   */
  patch: string | null;
}

export interface PullRequestDiff {
  files: ChangedFile[];
  /** true if we hit GitHub's 3000-file cap, so `files` may be incomplete. */
  truncated: boolean;
}
