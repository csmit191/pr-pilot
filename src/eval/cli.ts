import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_LLM_MODEL } from "../config.js";
import { createAnthropicProvider } from "../llm/anthropic.js";
import { summarizePullRequest, type SummarizeFn } from "../llm/summarize.js";
import { logger } from "../logger.js";
import { collectCommand, latestRunDir, reportCommand, runCommand } from "./commands.js";
import { createLiveGithub } from "./githubLive.js";

const USAGE = `PR Pilot evaluation

  collect   Download the merged PRs listed in eval/prs.txt (needs GITHUB_TOKEN)
  run       Replay collected PRs through the pipeline with the real LLM (needs ANTHROPIC_API_KEY)
  report    Compute precision, recall, latency and cost into a README-ready table

Options
  --prs <file>            PR list for collect                 (default eval/prs.txt)
  --snapshots <dir>       where snapshots live                (default eval/snapshots)
  --dataset <file>        labels                              (default eval/dataset.json)
  --force                 collect: refetch PRs already collected
  --no-llm                run: evaluate the rule-based checks only (free)
  --limit <n>             run: only the first n labeled PRs (cheap trial run)
  --out <dir>             run: results folder                 (default eval/results/<timestamp>)
  --run <dir>             report: results folder              (default: the newest one)
  --input-price <usd>     report: USD per million input tokens
  --output-price <usd>    report: USD per million output tokens
  --verbose               show the pipeline's own log lines
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      prs: { type: "string", default: "eval/prs.txt" },
      snapshots: { type: "string", default: "eval/snapshots" },
      dataset: { type: "string", default: "eval/dataset.json" },
      out: { type: "string" },
      run: { type: "string" },
      force: { type: "boolean", default: false },
      "no-llm": { type: "boolean", default: false },
      limit: { type: "string" },
      "input-price": { type: "string" },
      "output-price": { type: "string" },
      verbose: { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  const log = (message: string): void => console.log(message);

  if (!values.verbose) {
    // The pipeline logs JSON lines for the server; here they would bury the progress output.
    logger.info = () => {};
  }

  if (command === "collect") {
    if (!process.env.GITHUB_TOKEN) log("Warning: GITHUB_TOKEN is not set. Unauthenticated requests are limited to 60 per hour, which is not enough for 25 PRs.");
    const outcome = await collectCommand({
      prsFile: values.prs,
      snapshotsDir: values.snapshots,
      datasetPath: values.dataset,
      force: values.force,
      live: createLiveGithub({ token: process.env.GITHUB_TOKEN }),
      log,
    });
    log(`\nCollected ${outcome.collected.length}, skipped ${outcome.skipped.length}, failed ${outcome.failed.length}.`);
    if (outcome.collected.length > 0) {
      log(`Next: open ${values.dataset}, read each PR, write its labels, and set "status" to "labeled".`);
    }
    return;
  }

  if (command === "run") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = process.env.LLM_MODEL || DEFAULT_LLM_MODEL;
    let summarize: SummarizeFn | undefined;
    if (!values["no-llm"]) {
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Set it, or pass --no-llm to evaluate the rule-based checks only.");
      const provider = createAnthropicProvider({ apiKey, model });
      summarize = (input) => summarizePullRequest(input, provider);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outDir = values.out ?? join("eval", "results", stamp);
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive whole number");

    const outcome = await runCommand({ datasetPath: values.dataset, snapshotsDir: values.snapshots, outDir, summarize, model, limit, log });
    log(`\nRan ${outcome.ran} PR(s) (${outcome.skipped.length} skipped). Results in ${outDir}`);
    log(`Next: open ${join(outDir, "judging-guide.md")} and fill in ${join(outDir, "judgments.json")}, then run report.`);
    return;
  }

  if (command === "report") {
    const runDir = values.run ?? (await latestRunDir(join("eval", "results")));
    if (!runDir) throw new Error("No results found. Run `run` first, or pass --run <dir>.");

    const inputPrice = values["input-price"] === undefined ? undefined : Number(values["input-price"]);
    const outputPrice = values["output-price"] === undefined ? undefined : Number(values["output-price"]);
    const priced = inputPrice !== undefined && outputPrice !== undefined && Number.isFinite(inputPrice) && Number.isFinite(outputPrice);
    if (!priced) log("No --input-price/--output-price given, so cost will not be computed.\n");

    const { markdown } = await reportCommand({
      datasetPath: values.dataset,
      runDir,
      pricing: priced ? { inputPerMTok: inputPrice, outputPerMTok: outputPrice } : null,
      log,
    });
    log(markdown);
    log(`(Saved to ${join(runDir, "report.md")})`);
    return;
  }

  log(USAGE);
  if (command !== undefined && command !== "help") process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
