import { z } from "zod";

/** One commit that touched a file, reduced to what reviewer scoring needs. */
export interface CommitInfo {
  /** null when the commit's email isn't linked to a GitHub account. */
  authorLogin: string | null;
  authorIsBot: boolean;
  /** ISO 8601 timestamp. */
  date: string;
}

// .catch(null): GitHub returns `{}` (not null) for the author of unlinked commits, which would
// otherwise fail validation and discard the whole commit.
const person = z.object({ date: z.string().optional() }).nullish().catch(null);

const commitSchema = z.object({
  author: z.object({ login: z.string(), type: z.string().optional() }).nullish().catch(null),
  commit: z.object({ author: person, committer: person }),
});

/** Validates a "list commits" response. Items we can't use (no usable date) are dropped. */
export function parseCommitHistory(data: unknown): CommitInfo[] {
  if (!Array.isArray(data)) throw new Error("Unexpected commit list response");

  return data.flatMap((item): CommitInfo[] => {
    const parsed = commitSchema.safeParse(item);
    if (!parsed.success) return [];

    const { author, commit } = parsed.data;
    const date = commit.author?.date ?? commit.committer?.date;
    if (date === undefined) return [];

    const login = author?.login ?? null;
    return [
      {
        authorLogin: login,
        authorIsBot: author?.type === "Bot" || (login?.toLowerCase().endsWith("[bot]") ?? false),
        date,
      },
    ];
  });
}
