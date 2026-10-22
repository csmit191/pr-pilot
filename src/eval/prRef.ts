export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  /** "owner/repo#123" */
  id: string;
  url: string;
}

const NAME = "[A-Za-z0-9_.-]+";
const SHORT = new RegExp(`^(${NAME})/(${NAME})#(\\d+)$`);
// Accepts https://github.com/o/r/pull/12, with an optional /files, /commits... tail, query or fragment.
const URL_FORM = new RegExp(`^https://github\\.com/(${NAME})/(${NAME})/pull/(\\d+)(?:/[A-Za-z]*)?/?(?:[?#].*)?$`);

const isDotName = (name: string): boolean => name === "." || name === "..";

/** Parses "owner/repo#123" or a GitHub PR URL. Returns null for anything else. */
export function parsePrRef(text: string): PrRef | null {
  const trimmed = text.trim();
  const match = SHORT.exec(trimmed) ?? URL_FORM.exec(trimmed);
  if (!match) return null;

  const [, owner, repo, rawNumber] = match;
  if (owner === undefined || repo === undefined || rawNumber === undefined) return null;
  // "." and ".." are valid under the character rules but would change the API path we build.
  if (isDotName(owner) || isDotName(repo)) return null;

  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number) || number <= 0) return null;

  return { owner, repo, number, id: `${owner}/${repo}#${number}`, url: `https://github.com/${owner}/${repo}/pull/${number}` };
}

/** A filesystem-safe name for a PR's snapshot. */
export const snapshotFileName = (ref: Pick<PrRef, "owner" | "repo" | "number">): string =>
  `${ref.owner}__${ref.repo}__${ref.number}.json`;
