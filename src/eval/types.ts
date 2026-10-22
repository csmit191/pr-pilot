import { z } from "zod";
import { FILE_STATUSES } from "../diff/types.js";
import { SEVERITIES } from "../risk/types.js";

// ---------------------------------------------------------------------------------------------
// The dataset: which PRs, and what a careful human would flag in each (written by you)
// ---------------------------------------------------------------------------------------------

/**
 * Categories a labeled risk can have. The first six are exactly the deterministic rules, so a
 * label like { category: "dependencies" } can be matched automatically. "semantic" is everything
 * only a reader would notice (a bug, a breaking change, missing error handling): those can only
 * be caught by the LLM, and whether it did is your judgment.
 */
export const LABEL_CATEGORIES = [
  "secrets",
  "sensitivePaths",
  "deletedTests",
  "dependencies",
  "migrations",
  "largeDiff",
  "semantic",
] as const;
export type LabelCategory = (typeof LABEL_CATEGORIES)[number];

// .strict() so a typo like "lables" is an error, not a silently ignored field.
export const labelSchema = z
  .object({
    /** The changed file the risk is about. Omit for PR-wide risks (e.g. "too big to review"). */
    file: z.string().min(1).optional(),
    category: z.enum(LABEL_CATEGORIES),
    description: z.string().min(1),
  })
  .strict();
export type EvalLabel = z.infer<typeof labelSchema>;

export const datasetEntrySchema = z
  .object({
    /** "owner/repo#123" */
    id: z.string().min(1),
    url: z.string().min(1),
    title: z.string(),
    /**
     * "unlabeled" until YOU have read the PR and written its labels. An empty `labels` list with
     * status "labeled" means "I looked and there is nothing a careful reviewer would flag".
     */
    status: z.enum(["unlabeled", "labeled"]),
    labels: z.array(labelSchema),
    notes: z.string().optional(),
  })
  .strict();
export type DatasetEntry = z.infer<typeof datasetEntrySchema>;

export const datasetSchema = z.object({ version: z.literal(1), prs: z.array(datasetEntrySchema) }).strict();
export type Dataset = z.infer<typeof datasetSchema>;

// ---------------------------------------------------------------------------------------------
// Snapshots: everything GitHub told us about one PR, so a run is repeatable and offline
// ---------------------------------------------------------------------------------------------

const changedFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  status: z.enum(FILE_STATUSES),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().nullable(),
});

const commitInfoSchema = z.object({
  authorLogin: z.string().nullable(),
  authorIsBot: z.boolean(),
  date: z.string(),
});

export const snapshotSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  meta: z.object({
    title: z.string(),
    body: z.string().nullable(),
    author: z.string(),
    baseSha: z.string(),
    headSha: z.string(),
    mergedAt: z.string().nullable(),
    collectedAt: z.string(),
  }),
  diff: z.object({ files: z.array(changedFileSchema), truncated: z.boolean() }),
  /** Text of files the pipeline asked for (config, CODEOWNERS), by path; null = didn't exist. */
  files: z.record(z.string().nullable()),
  /** Recent commits for files the pipeline asked history for, by path. */
  history: z.record(z.array(commitInfoSchema)),
  /** How long the live GitHub fetching took when this PR was collected. */
  collectMs: z.number().nonnegative(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

// ---------------------------------------------------------------------------------------------
// Run results and judgments
// ---------------------------------------------------------------------------------------------

export const findingSchema = z.object({
  /** r0, r1... for rule-based flags; l0, l1... for risks the LLM reported. Unique within a PR. */
  id: z.string(),
  source: z.enum(["rule", "llm"]),
  rule: z.string().optional(),
  severity: z.enum(SEVERITIES),
  file: z.string().optional(),
  line: z.number().optional(),
  text: z.string(),
});
export type EvalFinding = z.infer<typeof findingSchema>;

export const prResultSchema = z.object({
  id: z.string(),
  durationMs: z.number().nonnegative(),
  collectMs: z.number().nonnegative(),
  findings: z.array(findingSchema),
  summary: z.object({
    status: z.enum(["ok", "failed", "disabled"]),
    error: z.string().optional(),
    mode: z.enum(["single", "map-reduce"]).optional(),
    calls: z.number().optional(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    /** The summary text, kept so you can read what the model said. */
    text: z.string().optional(),
  }),
});
export type PrResult = z.infer<typeof prResultSchema>;

export const runResultsSchema = z.object({
  version: z.literal(1),
  startedAt: z.string(),
  model: z.string().nullable(),
  prs: z.array(prResultSchema),
});
export type RunResults = z.infer<typeof runResultsSchema>;

/**
 * Your verdicts for one PR.
 *  - findings: finding id -> true (a reviewer would agree this is worth attention),
 *              false (noise / wrong), or null (not judged yet).
 *  - labels:   label index -> the id of the finding that caught it, "none" if the tool missed it,
 *              or null (not judged yet).
 */
export const prJudgmentSchema = z.object({
  findings: z.record(z.boolean().nullable()),
  labels: z.record(z.string().nullable()),
});
export type PrJudgment = z.infer<typeof prJudgmentSchema>;

export const judgmentsSchema = z.object({ version: z.literal(1), prs: z.record(prJudgmentSchema) });
export type Judgments = z.infer<typeof judgmentsSchema>;

export interface Pricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}
