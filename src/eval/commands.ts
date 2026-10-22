import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ZodType, ZodTypeDef } from "zod";
import type { SummarizeFn } from "../llm/summarize.js";
import { runReview } from "../review/pipeline.js";
import { renderJudgingGuide } from "./guide.js";
import type { LiveGithub } from "./githubLive.js";
import { extractFindings, mergeJudgment, skeletonJudgment } from "./judge.js";
import { computeMetrics, type Metrics } from "./metrics.js";
import { parsePrRef, snapshotFileName, type PrRef } from "./prRef.js";
import { renderReport } from "./report.js";
import { createRecorder, createReplayDeps } from "./snapshot.js";
import {
  datasetSchema,
  judgmentsSchema,
  runResultsSchema,
  snapshotSchema,
  type Dataset,
  type DatasetEntry,
  type Judgments,
  type Pricing,
  type PrResult,
  type RunResults,
  type Snapshot,
} from "./types.js";

type Log = (message: string) => void;

// ---------------------------------------------------------------------------------------------
// Small file helpers
// ---------------------------------------------------------------------------------------------

async function readJson<T>(path: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  const parsed = schema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) {
    const detail = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${path} is not valid: ${detail}`);
  }
  return parsed.data;
}

async function readJsonIfExists<T>(path: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T | null> {
  try {
    return await readJson(path, schema);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

const isNotFound = (err: unknown): boolean => typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";

/** Like readJson, but a missing file becomes a message that says what to do about it. */
async function readRequired<T>(path: string, schema: ZodType<T, ZodTypeDef, unknown>, hint: string): Promise<T> {
  try {
    return await readJson(path, schema);
  } catch (err) {
    if (isNotFound(err)) throw new Error(`${path} was not found. ${hint}`);
    throw err;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------------------------
// collect: download merged PRs once, save everything the pipeline needs
// ---------------------------------------------------------------------------------------------

export interface CollectOptions {
  prsFile: string;
  snapshotsDir: string;
  datasetPath: string;
  force: boolean;
  live: LiveGithub;
  log: Log;
  now?: () => Date;
}

export interface CollectOutcome {
  collected: string[];
  skipped: string[];
  failed: Array<{ ref: string; error: string }>;
}

/** Reads one PR reference per line. Lines starting with # are comments ("owner/repo#1" contains a # too). */
export function parsePrList(text: string): { refs: PrRef[]; invalid: string[] } {
  const refs: PrRef[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const ref = parsePrRef(line);
    if (!ref) invalid.push(line);
    else if (!seen.has(ref.id)) {
      seen.add(ref.id);
      refs.push(ref);
    }
  }
  return { refs, invalid };
}

export async function collectPr(ref: PrRef, live: LiveGithub, now: () => Date = () => new Date()): Promise<Snapshot> {
  const meta = await live.getPullRequestMeta(ref.owner, ref.repo, ref.number);
  if (!meta.merged) throw new Error("this PR is not merged; the evaluation uses merged PRs only");

  // Run the real pipeline (without the LLM) against live GitHub and record every answer.
  const recorder = createRecorder(live);
  const review = await runReview(
    { installationId: 0, owner: ref.owner, repo: ref.repo, number: ref.number, action: "eval", title: meta.title, body: meta.body, author: meta.author, baseSha: meta.baseSha },
    recorder.deps,
  );
  const recording = recorder.recording();

  return {
    version: 1,
    id: ref.id,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    meta: { title: meta.title, body: meta.body, author: meta.author, baseSha: meta.baseSha, headSha: meta.headSha, mergedAt: meta.mergedAt, collectedAt: now().toISOString() },
    diff: recording.diff ?? review.diff,
    files: recording.files,
    history: recording.history,
    collectMs: review.durationMs,
  };
}

export async function collectCommand(options: CollectOptions): Promise<CollectOutcome> {
  let prList: string;
  try {
    prList = await readFile(options.prsFile, "utf8");
  } catch (err) {
    if (isNotFound(err)) throw new Error(`PR list ${options.prsFile} was not found. Create it with one PR per line (owner/repo#123 or a GitHub PR URL).`);
    throw err;
  }
  const { refs, invalid } = parsePrList(prList);
  for (const line of invalid) options.log(`Ignoring line that is not a PR reference: ${line}`);

  const dataset: Dataset = (await readJsonIfExists(options.datasetPath, datasetSchema)) ?? { version: 1, prs: [] };
  const known = new Set(dataset.prs.map((e) => e.id));
  const outcome: CollectOutcome = { collected: [], skipped: [], failed: [] };

  for (const ref of refs) {
    const snapshotPath = join(options.snapshotsDir, snapshotFileName(ref));
    const exists = (await readJsonIfExists(snapshotPath, snapshotSchema).catch(() => null)) !== null;
    if (exists && !options.force) {
      outcome.skipped.push(ref.id);
      options.log(`skip     ${ref.id} (already collected; use --force to refetch)`);
      continue;
    }
    try {
      const snapshot = await collectPr(ref, options.live, options.now);
      await writeJson(snapshotPath, snapshot);
      outcome.collected.push(ref.id);
      options.log(`collect  ${ref.id}: ${snapshot.diff.files.length} files, ${(snapshot.collectMs / 1000).toFixed(1)} s`);

      if (!known.has(ref.id)) {
        // A skeleton entry for YOU to fill in. "unlabeled" keeps it out of the metrics until you do.
        const entry: DatasetEntry = { id: ref.id, url: ref.url, title: snapshot.meta.title, status: "unlabeled", labels: [] };
        dataset.prs.push(entry);
        known.add(ref.id);
      }
    } catch (err) {
      outcome.failed.push({ ref: ref.id, error: errorMessage(err) });
      options.log(`FAILED   ${ref.id}: ${errorMessage(err)}`);
    }
  }

  await writeJson(options.datasetPath, dataset);
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// run: replay snapshots through the real pipeline
// ---------------------------------------------------------------------------------------------

export interface RunCommandOptions {
  datasetPath: string;
  snapshotsDir: string;
  outDir: string;
  /** Absent to evaluate the rule-based checks alone. */
  summarize?: SummarizeFn | undefined;
  model: string | null;
  limit?: number | undefined;
  log: Log;
  now?: () => Date;
}

export interface RunCommandOutcome {
  ran: number;
  skipped: string[];
  results: RunResults;
}

export async function runCommand(options: RunCommandOptions): Promise<RunCommandOutcome> {
  const dataset = await readRequired(options.datasetPath, datasetSchema, "Run `eval:collect` first, then label the PRs it lists.");
  const labeled = dataset.prs.filter((e) => e.status === "labeled");
  if (labeled.length === 0) {
    throw new Error('No PR in the dataset has status "labeled" yet. Write each PR\'s labels, then set its status to "labeled".');
  }
  const selected = options.limit === undefined ? labeled : labeled.slice(0, options.limit);

  const results: RunResults = { version: 1, startedAt: (options.now ?? (() => new Date()))().toISOString(), model: options.summarize ? options.model : null, prs: [] };
  const skipped: string[] = [];

  // One PR at a time, on purpose: parallel runs would distort the latency numbers and trip rate limits.
  for (const entry of selected) {
    const ref = parsePrRef(entry.id);
    const snapshot = ref ? await readJsonIfExists(join(options.snapshotsDir, snapshotFileName(ref)), snapshotSchema) : null;
    if (!snapshot) {
      skipped.push(entry.id);
      options.log(`skip     ${entry.id} (no snapshot; run collect first)`);
      continue;
    }

    const review = await runReview(
      { installationId: 0, owner: snapshot.owner, repo: snapshot.repo, number: snapshot.number, action: "eval", title: snapshot.meta.title, body: snapshot.meta.body, author: snapshot.meta.author, baseSha: snapshot.meta.baseSha },
      { ...createReplayDeps(snapshot), summarize: options.summarize },
    );

    const usage = review.summary.status === "ok" ? review.summary.result.usage : review.summary.status === "failed" ? review.summary.usage : undefined;
    const result: PrResult = {
      id: entry.id,
      durationMs: review.durationMs,
      collectMs: snapshot.collectMs,
      findings: extractFindings(review),
      summary: {
        status: review.summary.status,
        error: review.summary.status === "failed" ? review.summary.error : undefined,
        mode: review.summary.status === "ok" ? review.summary.result.mode : undefined,
        calls: review.summary.status === "ok" ? review.summary.result.calls : undefined,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        text: review.summary.status === "ok" ? review.summary.result.summary.summary : undefined,
      },
    };
    results.prs.push(result);
    options.log(`ran      ${entry.id}: ${result.findings.length} findings, ${(result.durationMs / 1000).toFixed(1)} s, ${result.summary.status}`);
  }

  // Judgments: auto-fill what is mechanical, keep anything you already wrote in this folder.
  const judgmentsPath = join(options.outDir, "judgments.json");
  const existing = await readJsonIfExists(judgmentsPath, judgmentsSchema);
  const judgments: Judgments = { version: 1, prs: {} };
  for (const result of results.prs) {
    const entry = selected.find((e) => e.id === result.id) as DatasetEntry;
    judgments.prs[result.id] = mergeJudgment(existing?.prs[result.id], skeletonJudgment(entry, result.findings));
  }

  await writeJson(join(options.outDir, "results.json"), results);
  await writeJson(judgmentsPath, judgments);
  await writeFile(join(options.outDir, "judging-guide.md"), renderJudgingGuide(dataset, results, judgments), "utf8");
  return { ran: results.prs.length, skipped, results };
}

// ---------------------------------------------------------------------------------------------
// report: turn labels + results + your judgments into the README table
// ---------------------------------------------------------------------------------------------

export interface ReportOptions {
  datasetPath: string;
  runDir: string;
  pricing: Pricing | null;
  log: Log;
  now?: () => Date;
}

export async function reportCommand(options: ReportOptions): Promise<{ markdown: string; metrics: Metrics }> {
  const dataset = await readRequired(options.datasetPath, datasetSchema, "Run `eval:collect` first, then label the PRs it lists.");
  const results = await readRequired(join(options.runDir, "results.json"), runResultsSchema, "Run `eval:run` first.");
  const judgments = await readJsonIfExists(join(options.runDir, "judgments.json"), judgmentsSchema);
  if (!judgments) options.log("No judgments.json found; every verdict counts as pending.");

  const metrics = computeMetrics({ dataset, results, judgments, pricing: options.pricing });
  const date = (options.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const markdown = renderReport(metrics, { model: results.model, pricing: options.pricing, date });

  await writeFile(join(options.runDir, "report.md"), markdown, "utf8");
  await writeFile(join(options.runDir, "judging-guide.md"), renderJudgingGuide(dataset, results, judgments ?? { version: 1, prs: {} }), "utf8");
  return { markdown, metrics };
}

/** The most recent results folder (their names are timestamps, so alphabetical order is chronological). */
export async function latestRunDir(resultsDir: string): Promise<string | null> {
  try {
    const names = (await readdir(resultsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const last = names.at(-1);
    return last === undefined ? null : join(resultsDir, last);
  } catch {
    return null;
  }
}
