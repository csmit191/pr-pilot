import { z } from "zod";
import { FILE_STATUSES, type ChangedFile } from "./types.js";

// Only the fields we use. zod strips everything else (sha, blob_url, raw_url, ...).
const rawFile = z.object({
  filename: z.string(),
  // .catch: if GitHub ever adds a new status, degrade to "changed" instead of crashing.
  status: z.enum(FILE_STATUSES).catch("changed"),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
  previous_filename: z.string().optional(),
});

/** Validates raw GitHub "list pull request files" items and maps them to our own shape. */
export function parseChangedFiles(raw: unknown[]): ChangedFile[] {
  return z
    .array(rawFile)
    .parse(raw)
    .map((f) => ({
      path: f.filename,
      ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? null,
    }));
}
