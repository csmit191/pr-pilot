import { z } from "zod";

/** An existing comment on the PR, reduced to what we need to recognize our own. */
export interface ExistingComment {
  id: number;
  body: string;
  /** Id of the GitHub App that posted it, or null for ordinary users. */
  appId: number | null;
}

const commentSchema = z.object({
  id: z.number(),
  body: z.string().nullish(),
  performed_via_github_app: z.object({ id: z.number() }).nullish().catch(null),
});

/** Validates a "list issue comments" response. */
export function parseIssueComments(data: unknown): ExistingComment[] {
  if (!Array.isArray(data)) throw new Error("Unexpected comment list response");
  return data.flatMap((item): ExistingComment[] => {
    const parsed = commentSchema.safeParse(item);
    if (!parsed.success) return [];
    const { id, body, performed_via_github_app } = parsed.data;
    return [{ id, body: body ?? "", appId: performed_via_github_app?.id ?? null }];
  });
}
