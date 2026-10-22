import { z } from "zod";
import { SEVERITIES } from "../risk/types.js";

const severity = z.enum(SEVERITIES);

// Limits are a little looser than what the prompt asks for, so a model that writes 7 key
// changes instead of 6 isn't rejected, while a runaway answer still is.
export const reviewSummarySchema = z.object({
  summary: z.string().min(1).max(1500),
  keyChanges: z.array(z.string().min(1).max(300)).max(10),
  risks: z
    .array(
      z.object({
        file: z.string().min(1),
        reason: z.string().min(1).max(500),
        severity,
      }),
    )
    .max(15),
  testingSuggestions: z.array(z.string().min(1).max(300)).max(8),
});

export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

/** Output of the per-file step used for large PRs. */
export const fileSummarySchema = z.object({
  summary: z.string().min(1).max(600),
  risks: z.array(z.object({ reason: z.string().min(1).max(400), severity })).max(5),
});

export type FileSummary = z.infer<typeof fileSummarySchema>;
