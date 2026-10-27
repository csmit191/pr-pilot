import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectCommand, latestRunDir, parsePrList, reportCommand, runCommand } from "../src/eval/commands.js";
import { GitHubApiError, type LiveGithub, type PrMeta } from "../src/eval/githubLive.js";
import type { Dataset, Judgments, RunResults } from "../src/eval/types.js";
import type { ChangedFile } from "../src/diff/types.js";
import { LlmOutputError, type SummarizeFn, type SummaryResult } from "../src/llm/summarize.js";
import { logger } from "../src/logger.js";
import type { CommitInfo } from "../src/reviewers/history.js";

// ------------------------------------------------------------------------------------------------
// A tiny fake GitHub with four pull requests
// ------------------------------------------------------------------------------------------------

interface FakePr {
  meta: PrMeta;
  files: ChangedFile[];
  history?: Record<string, CommitInfo[]>;
}

const meta = (title: string, merged = true): PrMeta => ({
  title,
  body: null,
  author: "octocat",
  baseSha: "base111",
  headSha: "head222",
  merged,
  mergedAt: merged ? "2026-09-01T10:00:00Z" : null,
});

const PRS: Record<number, FakePr> = {
  1: {
    meta: meta("Fix login"),
    files: [
      { path: "src/auth/login.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1,2 +1,3 @@\n keep\n-old\n+audit(user);\n+return user;" },
      { path: "test/login.test.ts", status: "removed", additions: 0, deletions: 2, patch: "@@ -1,2 +0,0 @@\n-it('works', () => {});\n-// end" },
      { path: "README.md", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n hello\n+more" },
    ],
    history: { "src/auth/login.ts": [{ authorLogin: "alice", authorIsBot: false, date: "2026-08-01T00:00:00Z" }] },
  },
  2: { meta: meta("Tidy util"), files: [{ path: "src/util.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b" }] },
  3: { meta: meta("Config tweak"), files: [{ path: "src/config.ts", status: "modified", additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n x\n+const password = "abc";' }] },
  4: { meta: meta("Still open", false), files: [] },
};

function makeLive() {
  const calls: string[] = [];
  const live: LiveGithub = {
    async getPullRequestMeta(_owner, _repo, number) {
      calls.push(`meta ${number}`);
      const pr = PRS[number];
      if (!pr) throw new GitHubApiError("GitHub API 404 for /repos/acme/widgets/pulls/" + number, 404);
      return pr.meta;
    },
    async getPullRequestDiff(_i, _o, _r, number) {
      return { files: PRS[number]?.files ?? [], truncated: false };
    },
    async getFileContent() {
      return null;
    },
    async getFileHistory(_i, _o, _r, path) {
      return Object.values(PRS).flatMap((pr) => pr.history?.[path] ?? []);
    },
  };
  return { live, calls };
}

const RISKS: Record<string, SummaryResult["summary"]["risks"]> = {
  "Fix login": [
    { file: "src/auth/login.ts", reason: "The audit write is not awaited.", severity: "medium" },
    { file: "README.md", reason: "Nitpick about wording.", severity: "low" },
  ],
  "Tidy util": [{ file: "src/util.ts", reason: "Might be slow.", severity: "low" }],
};
const summarize: SummarizeFn = async (input) => ({
  summary: { summary: `About ${input.title}`, keyChanges: [], risks: RISKS[input.title] ?? [], testingSuggestions: [] },
  usage: { inputTokens: 1000, outputTokens: 200 },
  calls: 1,
  mode: "single",
});

// ------------------------------------------------------------------------------------------------

let dir: string;
let paths: { prs: string; snapshots: string; dataset: string; results: string };
const logs: string[] = [];
const log = (message: string) => void logs.push(message);
const read = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "prpilot-eval-"));
  paths = { prs: join(dir, "prs.txt"), snapshots: join(dir, "snapshots"), dataset: join(dir, "dataset.json"), results: join(dir, "results") };
  logs.length = 0;
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const collect = (live: LiveGithub, force = false) =>
  collectCommand({ prsFile: paths.prs, snapshotsDir: paths.snapshots, datasetPath: paths.dataset, force, live, log, now: () => new Date("2026-10-22T12:00:00Z") });

/** Plays the part of the human: writes the labels and marks the PRs as labeled. */
async function labelDataset(): Promise<void> {
  const dataset = await read<Dataset>(paths.dataset);
  const byId = new Map(dataset.prs.map((e) => [e.id, e]));
  Object.assign(byId.get("acme/widgets#1") ?? {}, {
    status: "labeled",
    labels: [
      { category: "sensitivePaths", file: "src/auth/login.ts", description: "touches auth" },
      { category: "deletedTests", file: "test/login.test.ts", description: "deleted a test" },
      { category: "semantic", file: "src/auth/login.ts", description: "audit write is not awaited" },
    ],
  });
  Object.assign(byId.get("acme/widgets#2") ?? {}, { status: "labeled", labels: [] }); // a clean PR
  Object.assign(byId.get("acme/widgets#3") ?? {}, {
    status: "labeled",
    labels: [{ category: "secrets", file: "src/config.ts", description: "hardcoded password" }],
  });
  await writeFile(paths.dataset, JSON.stringify(dataset, null, 2));
}

describe("parsePrList", () => {
  it("reads one reference per line, skipping comments, blanks and duplicates, and reporting junk", () => {
    const { refs, invalid } = parsePrList(
      ["# my picks", "", "acme/widgets#1", "https://github.com/acme/widgets/pull/2/files", "  acme/widgets#1  ", "not a pr", "# acme/widgets#99"].join("\r\n"),
    );
    expect(refs.map((r) => r.id)).toEqual(["acme/widgets#1", "acme/widgets#2"]);
    expect(invalid).toEqual(["not a pr"]);
  });
});

describe("collect", () => {
  beforeEach(async () => {
    await writeFile(paths.prs, "# picks\nacme/widgets#1\nhttps://github.com/acme/widgets/pull/2/files\nacme/widgets#3\nnot a pr\n");
  });

  it("saves a snapshot per PR and a dataset skeleton for you to label", async () => {
    const { live } = makeLive();
    const outcome = await collect(live);

    expect(outcome).toEqual({ collected: ["acme/widgets#1", "acme/widgets#2", "acme/widgets#3"], skipped: [], failed: [] });
    expect(logs.join("\n")).toContain("Ignoring line that is not a PR reference: not a pr");

    const snapshot = await read<{ id: string; meta: { title: string; collectedAt: string }; diff: { files: unknown[] }; files: Record<string, unknown>; history: Record<string, unknown> }>(join(paths.snapshots, "acme__widgets__1.json"));
    expect(snapshot.id).toBe("acme/widgets#1");
    expect(snapshot.meta).toMatchObject({ title: "Fix login", collectedAt: "2026-10-22T12:00:00.000Z" });
    expect(snapshot.diff.files).toHaveLength(3);
    // everything the pipeline asked GitHub for was recorded, including "this file doesn't exist"
    expect(snapshot.files).toMatchObject({ ".prpilot.yml": null, ".github/CODEOWNERS": null, CODEOWNERS: null, "docs/CODEOWNERS": null });
    expect(Object.keys(snapshot.history)).toContain("src/auth/login.ts");

    const dataset = await read<Dataset>(paths.dataset);
    expect(dataset.prs.map((e) => [e.id, e.status, e.labels.length])).toEqual([
      ["acme/widgets#1", "unlabeled", 0],
      ["acme/widgets#2", "unlabeled", 0],
      ["acme/widgets#3", "unlabeled", 0],
    ]);
    expect(dataset.prs[0]).toMatchObject({ title: "Fix login", url: "https://github.com/acme/widgets/pull/1" });
  });

  it("skips PRs it already has, unless forced, and never touches existing labels", async () => {
    const first = makeLive();
    await collect(first.live);
    await labelDataset();

    const again = makeLive();
    const outcome = await collect(again.live);
    expect(outcome.skipped).toHaveLength(3);
    expect(outcome.collected).toEqual([]);
    expect(again.calls).toEqual([]);

    const forced = makeLive();
    expect((await collect(forced.live, true)).collected).toHaveLength(3);
    const dataset = await read<Dataset>(paths.dataset);
    expect(dataset.prs.map((e) => e.id)).toEqual(["acme/widgets#1", "acme/widgets#2", "acme/widgets#3"]); // no duplicates
    expect(dataset.prs.find((e) => e.id === "acme/widgets#1")).toMatchObject({ status: "labeled" });
    expect(dataset.prs.find((e) => e.id === "acme/widgets#1")?.labels).toHaveLength(3);
  });

  it("reports PRs that are not merged or can't be fetched, and carries on with the rest", async () => {
    await writeFile(paths.prs, "acme/widgets#4\nacme/widgets#404\nacme/widgets#2\n");
    const outcome = await collect(makeLive().live);

    expect(outcome.collected).toEqual(["acme/widgets#2"]);
    expect(outcome.failed.map((f) => f.ref)).toEqual(["acme/widgets#4", "acme/widgets#404"]);
    expect(outcome.failed[0]?.error).toContain("not merged");
    expect(outcome.failed[1]?.error).toContain("404");
    const dataset = await read<Dataset>(paths.dataset);
    expect(dataset.prs.map((e) => e.id)).toEqual(["acme/widgets#2"]);
  });
});

describe("missing files give actionable errors", () => {
  it("keep the original file-system error as the cause", async () => {
    const collectError = (await collect(makeLive().live).catch((e: unknown) => e)) as Error;
    expect((collectError.cause as NodeJS.ErrnoException).code).toBe("ENOENT");

    const runError = (await runCommand({ datasetPath: paths.dataset, snapshotsDir: paths.snapshots, outDir: join(paths.results, "r"), model: null, log }).catch((e: unknown) => e)) as Error;
    expect((runError.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("collect without a PR list", async () => {
    await expect(collect(makeLive().live)).rejects.toThrow(/PR list .*prs\.txt was not found.*one PR per line/);
  });

  it("run without a dataset", async () => {
    await expect(runCommand({ datasetPath: paths.dataset, snapshotsDir: paths.snapshots, outDir: join(paths.results, "r"), model: null, log })).rejects.toThrow(/dataset\.json was not found.*eval:collect/);
  });

  it("report without results", async () => {
    await writeFile(paths.dataset, JSON.stringify({ version: 1, prs: [] }));
    await expect(reportCommand({ datasetPath: paths.dataset, runDir: join(dir, "nope"), pricing: null, log })).rejects.toThrow(/results\.json was not found.*eval:run/);
  });
});

describe("run", () => {
  beforeEach(async () => {
    await writeFile(paths.prs, "acme/widgets#1\nacme/widgets#2\nacme/widgets#3\n");
    await collect(makeLive().live);
    await labelDataset();
  });

  const run = (over: Partial<Parameters<typeof runCommand>[0]> = {}) =>
    runCommand({ datasetPath: paths.dataset, snapshotsDir: paths.snapshots, outDir: join(paths.results, "run1"), summarize, model: "test-model", log, now: () => new Date("2026-10-22T13:00:00Z"), ...over });

  it("replays snapshots through the real pipeline and records findings, tokens and timing", async () => {
    const outcome = await run();
    expect(outcome).toMatchObject({ ran: 3, skipped: [] });

    const results = await read<RunResults>(join(paths.results, "run1", "results.json"));
    expect(results).toMatchObject({ version: 1, model: "test-model", startedAt: "2026-10-22T13:00:00.000Z" });

    const pr1 = results.prs.find((r) => r.id === "acme/widgets#1");
    expect(pr1?.findings.map((f) => [f.id, f.source, f.rule ?? null, f.file])).toEqual([
      ["r0", "rule", "sensitivePaths", "src/auth/login.ts"],
      ["r1", "rule", "deletedTests", "test/login.test.ts"],
      ["l0", "llm", null, "src/auth/login.ts"],
      ["l1", "llm", null, "README.md"],
    ]);
    expect(pr1?.summary).toMatchObject({ status: "ok", mode: "single", calls: 1, inputTokens: 1000, outputTokens: 200, text: "About Fix login" });
    expect(pr1?.collectMs).toBeGreaterThanOrEqual(0);
    expect(results.prs.find((r) => r.id === "acme/widgets#3")?.findings).toEqual([]); // the weak password is missed
  });

  it("pre-fills judgments for everything mechanical and leaves opinions as null", async () => {
    await run();
    const judgments = await read<Judgments>(join(paths.results, "run1", "judgments.json"));
    expect(judgments.prs["acme/widgets#1"]).toEqual({
      labels: { "0": "r0", "1": "r1", "2": null },
      findings: { r0: true, r1: true, l0: null, l1: null },
    });
    expect(judgments.prs["acme/widgets#2"]).toEqual({ labels: {}, findings: { l0: null } });
    expect(judgments.prs["acme/widgets#3"]).toEqual({ labels: { "0": "none" }, findings: {} });

    const guide = await readFile(join(paths.results, "run1", "judging-guide.md"), "utf8");
    expect(guide).toContain("## acme/widgets#1: Fix login");
    expect(guide).toContain("label 2 [semantic]");
    expect(guide).toContain("TO DECIDE");
  });

  it("can evaluate the rule-based checks alone", async () => {
    await run({ summarize: undefined });
    const results = await read<RunResults>(join(paths.results, "run1", "results.json"));
    expect(results.model).toBeNull();
    expect(results.prs.every((r) => r.summary.status === "disabled")).toBe(true);
    expect(results.prs.flatMap((r) => r.findings).every((f) => f.source === "rule")).toBe(true);
  });

  it("records a failed LLM summary, including the tokens it already spent", async () => {
    const failing: SummarizeFn = async (input) => {
      if (input.title === "Fix login") throw new LlmOutputError("Model output failed validation after one retry.", { inputTokens: 300, outputTokens: 60 });
      throw new Error("provider down");
    };
    await run({ summarize: failing });
    const results = await read<RunResults>(join(paths.results, "run1", "results.json"));

    const invalidOutput = results.prs.find((r) => r.id === "acme/widgets#1");
    expect(invalidOutput?.summary).toMatchObject({ status: "failed", inputTokens: 300, outputTokens: 60 });
    expect(invalidOutput?.summary.error).toContain("failed validation");
    expect(invalidOutput?.findings.map((f) => f.source)).toEqual(["rule", "rule"]); // the rule-based findings survive

    const providerDown = results.prs.find((r) => r.id === "acme/widgets#2");
    expect(providerDown?.summary).toMatchObject({ status: "failed", inputTokens: 0, outputTokens: 0 });
  });

  it("honors --limit and skips PRs without a snapshot", async () => {
    expect((await run({ limit: 1 })).ran).toBe(1);

    const dataset = await read<Dataset>(paths.dataset);
    dataset.prs.push({ id: "acme/widgets#9", url: "u", title: "never collected", status: "labeled", labels: [] });
    await writeFile(paths.dataset, JSON.stringify(dataset));
    const outcome = await run({ outDir: join(paths.results, "run2") });
    expect(outcome.skipped).toEqual(["acme/widgets#9"]);
    expect(outcome.ran).toBe(3);
  });

  it("keeps the verdicts you already wrote if you re-run into the same folder", async () => {
    await run();
    const path = join(paths.results, "run1", "judgments.json");
    const judgments = await read<Judgments>(path);
    judgments.prs["acme/widgets#1"]!.labels["2"] = "l0";
    judgments.prs["acme/widgets#1"]!.findings.l1 = false;
    await writeFile(path, JSON.stringify(judgments));

    await run();
    const after = await read<Judgments>(path);
    expect(after.prs["acme/widgets#1"]?.labels["2"]).toBe("l0");
    expect(after.prs["acme/widgets#1"]?.findings.l1).toBe(false);
  });

  it("refuses to run when nothing has been labeled yet", async () => {
    const dataset = await read<Dataset>(paths.dataset);
    for (const entry of dataset.prs) entry.status = "unlabeled";
    await writeFile(paths.dataset, JSON.stringify(dataset));
    await expect(run()).rejects.toThrow('status "labeled"');
  });

  it("rejects a dataset with a typo, naming the problem", async () => {
    await writeFile(paths.dataset, JSON.stringify({ version: 1, prs: [{ id: "a/b#1", url: "u", title: "t", status: "labeled", lables: [] }] }));
    await expect(run()).rejects.toThrow(/dataset\.json is not valid/);
  });
});

describe("report, end to end", () => {
  const pricing = { inputPerMTok: 0.1, outputPerMTok: 0.5 };

  beforeEach(async () => {
    await writeFile(paths.prs, "acme/widgets#1\nacme/widgets#2\nacme/widgets#3\n");
    await collect(makeLive().live);
    await labelDataset();
    await runCommand({ datasetPath: paths.dataset, snapshotsDir: paths.snapshots, outDir: join(paths.results, "run1"), summarize, model: "claude-haiku-5-5", log, now: () => new Date("2026-10-22T13:00:00Z") });
  });

  const report = () => reportCommand({ datasetPath: paths.dataset, runDir: join(paths.results, "run1"), pricing, log, now: () => new Date("2026-10-22T14:00:00Z") });

  it("is a DRAFT until you have decided the open questions", async () => {
    const { metrics, markdown } = await report();
    expect(metrics.complete).toBe(false);
    expect(metrics.labels.pending).toBe(1); // PR 1's semantic label
    expect(metrics.findings.pending).toBe(3); // l0 and l1 of PR 1, l0 of PR 2
    expect(markdown).toContain("DRAFT");
    // the mechanical parts are already counted
    expect(metrics.labels).toMatchObject({ caught: 2, missed: 1, caughtByRules: 2 });
  });

  it("produces the final numbers once everything is judged", async () => {
    const path = join(paths.results, "run1", "judgments.json");
    const judgments = await read<Judgments>(path);
    judgments.prs["acme/widgets#1"]!.labels["2"] = "l0"; // the LLM caught the un-awaited audit write
    judgments.prs["acme/widgets#1"]!.findings.l1 = false; // the README nitpick is noise
    judgments.prs["acme/widgets#2"]!.findings.l0 = false; // a false alarm on a clean PR
    await writeFile(path, JSON.stringify(judgments));

    const { metrics, markdown } = await report();
    expect(metrics.complete).toBe(true);
    expect(metrics.prs).toEqual({ evaluated: 3, clean: 1, unlabeledSkipped: 0, missingResults: 0 });
    expect(metrics.recall).toMatchObject({ k: 3, n: 4, rate: 0.75 });
    expect(metrics.recallRulesOnly).toMatchObject({ k: 2, n: 4 });
    expect(metrics.precision.all).toMatchObject({ k: 3, n: 5 });
    expect(metrics.precision.rules).toMatchObject({ k: 2, n: 2 });
    expect(metrics.precision.llm).toMatchObject({ k: 1, n: 3 });
    expect(metrics.cost?.meanUsd).toBeCloseTo(0.0002, 10);

    expect(markdown).not.toContain("DRAFT");
    expect(markdown).toContain("| Recall, rules + LLM | 75% (3/4, 95% CI 30% to 95%) |");
    expect(markdown).toContain("with `claude-haiku-5-5`");
    expect(await readFile(join(paths.results, "run1", "report.md"), "utf8")).toBe(markdown);
  });

  it("works without pricing, just without cost", async () => {
    const { markdown } = await reportCommand({ datasetPath: paths.dataset, runDir: join(paths.results, "run1"), pricing: null, log });
    expect(markdown).toContain("| LLM cost per PR | not measured |");
  });

  it("tells you when judgments.json is missing", async () => {
    await rm(join(paths.results, "run1", "judgments.json"));
    const { metrics } = await report();
    expect(metrics.complete).toBe(false);
    expect(logs.join("\n")).toContain("No judgments.json found");
  });

  it("fails clearly when the results are missing", async () => {
    await expect(reportCommand({ datasetPath: paths.dataset, runDir: join(dir, "nope"), pricing, log })).rejects.toThrow();
  });
});

describe("latestRunDir", () => {
  it("returns the newest results folder, or null when there is none", async () => {
    expect(await latestRunDir(paths.results)).toBeNull();
    await mkdir(join(paths.results, "2026-10-21T10-00-00"), { recursive: true });
    await mkdir(join(paths.results, "2026-10-22T09-30-00"), { recursive: true });
    await writeFile(join(paths.results, "stray-file.txt"), "x");
    expect(await latestRunDir(paths.results)).toBe(join(paths.results, "2026-10-22T09-30-00"));
  });
});
