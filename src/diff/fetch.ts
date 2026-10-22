import { parseChangedFiles } from "./parse.js";
import type { PullRequestDiff } from "./types.js";

export const PER_PAGE = 100; // GitHub's maximum page size for this endpoint
export const MAX_PAGES = 30; // GitHub returns at most 3000 files per PR (30 x 100)

/** Fetches one page (1-indexed) of raw changed-file objects. */
export type FilePageSource = (page: number, perPage: number) => Promise<unknown[]>;

export async function fetchPullRequestDiff(fetchPage: FilePageSource): Promise<PullRequestDiff> {
  const raw: unknown[] = [];
  let reachedLastPage = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await fetchPage(page, PER_PAGE);
    raw.push(...items);
    // A short page means there is nothing after it. (A PR with exactly 100 files
    // costs one extra request that returns an empty page, which is fine.)
    if (items.length < PER_PAGE) {
      reachedLastPage = true;
      break;
    }
  }

  // If all 30 pages were full we can't tell whether more files exist, so we say truncated.
  return { files: parseChangedFiles(raw), truncated: !reachedLastPage };
}
