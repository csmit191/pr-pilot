# Evaluating PR Pilot

This folder holds the evaluation: real merged pull requests from public repositories, what **you**
decided a careful reviewer would flag in each, and how well PR Pilot did against that.

The tool can't do the human part for you, and shouldn't: the numbers are only worth quoting if the
labels are honest. The scripts handle everything else (downloading, replaying, scoring, confidence
intervals, the README table).

## One-time setup

```powershell
npm pkg set scripts.eval:collect="tsx --env-file=.env src/eval/cli.ts collect"
npm pkg set scripts.eval:run="tsx --env-file=.env src/eval/cli.ts run"
npm pkg set scripts.eval:report="tsx --env-file=.env src/eval/cli.ts report"
Add-Content -Path .gitignore -Value "eval/snapshots/"
```

- `GITHUB_TOKEN` in your `.env`: a personal access token that can read public repositories
  (github.com/settings/tokens, fine-grained, "Public repositories (read-only)"). Without it GitHub
  allows only 60 requests an hour, and collecting 25 PRs takes roughly 400.
- `ANTHROPIC_API_KEY` in your `.env` (you already have it) for the `run` step.
- Snapshots contain other people's code, so they are git-ignored. Commit `dataset.json` and the
  final results folder (labels, results, judgments, report) instead.

## The workflow

| Step | Command | What happens |
| --- | --- | --- |
| 1 | write `eval/prs.txt` | Pick the PRs (copy `prs.example.txt`). |
| 2 | `npm run eval:collect` | Downloads each PR once and saves a snapshot. Adds a skeleton entry per PR to `eval/dataset.json` with `"status": "unlabeled"`. |
| 3 | **you edit `eval/dataset.json`** | Read each PR on GitHub. Write down the risks a careful reviewer would flag. Set `"status": "labeled"`. |
| 4 | `npm run eval:run` | Replays the snapshots through the real pipeline with the real LLM. Writes `eval/results/<timestamp>/`. |
| 5 | **you edit `judgments.json`** in that folder | Decide what the tool got right. `judging-guide.md` shows everything side by side. |
| 6 | `npm run eval:report -- --input-price 0.10 --output-price 0.50` | Prints the markdown table and saves `report.md`. |

If `npm run x -- --flag` misbehaves in your shell, call it directly:
`npx tsx --env-file=.env src/eval/cli.ts report --input-price 0.10 --output-price 0.50`.

Useful flags: `run --no-llm` (rules only, free), `run --limit 3` (cheap trial), `collect --force`,
`report --run <folder>`. Prices are USD per million tokens; **check the provider's pricing page**
(Claude Haiku 5.5 was listed at $0.10 input / $0.50 output for prompts up to 100K tokens in
October 2026). The report prints the prices it used.

## Choosing PRs

- 20-30 merged PRs from at least 5-6 different public repos, in languages you can actually judge.
- A mix: small fixes, features, refactors, dependency bumps, a couple of big ones.
- **Include clean PRs** (5-8 where you find nothing worth flagging). They are what measure false
  alarms; without them precision looks better than it is.
- Pick before you look at what the tool says about them. Don't drop a PR because the tool did badly.
- Skip PRs touching huge generated files unless you want them in the evaluation.

## Writing labels (step 3)

Do this **before** running the tool, ideally before even collecting, so the answer key can't be
influenced by the tool's output.

```json
{
  "id": "acme/widgets#42",
  "url": "https://github.com/acme/widgets/pull/42",
  "title": "Fix login flow",
  "status": "labeled",
  "labels": [
    { "category": "sensitivePaths", "file": "src/auth/login.ts", "description": "Rewrites session handling" },
    { "category": "semantic", "file": "src/auth/login.ts", "description": "Audit write is not awaited, so failures are silent" }
  ]
}
```

- Label a risk if you would leave a review comment about it, judging from the diff alone.
- `category` is one of `secrets`, `sensitivePaths`, `deletedTests`, `dependencies`, `migrations`,
  `largeDiff` (the deterministic rules; matched to the tool's flags automatically) or `semantic`
  (anything only a reader notices: a bug, a breaking change, missing error handling; whether the LLM
  caught it is your call in step 5).
- `file` is the path as it appears in the PR. Omit it for PR-wide risks.
- A clean PR is `"status": "labeled"` with `"labels": []`. Leaving `"unlabeled"` excludes the PR.
- Decide your rubric up front (for example, "a dependency bump is only a risk if it is a major
  version or a new package") and apply it consistently.
- Don't edit labels after seeing results, except to fix typos. Otherwise you are fitting the answer
  key to the tool.

## Judging (step 5)

Open `judging-guide.md` and edit `judgments.json`. Things that are mechanical are pre-filled.

- **Each finding** (`r0`.. are rule-based, `l0`.. are the LLM's): `true` if a careful reviewer would
  agree it deserves attention in that PR, even if you didn't label it; `false` if it is noise,
  wrong, or trivial.
- **Each label**: the id of the finding that caught it (`"l0"`), or `"none"` if the tool missed it.
  "Caught" means it points at the same problem, not merely the same file.
- A finding that caught a labeled risk is automatically counted as reasonable.
- Anything still `null` makes the report print a **DRAFT** banner and list what is missing. Don't
  publish a DRAFT.
- Judgments belong to one run. If you change a prompt and run again, LLM findings change, and so
  must your judgments. Re-running into the *same* folder keeps verdicts whose ids still exist.

## Avoiding fooling yourself

- **Keep a dev set.** Tune rules and prompts on ~5 separate PRs (`--dataset eval/dev.json --prs
  eval/dev-prs.txt`) and report only on PRs you did not tune on. Numbers measured on the PRs you
  optimized against are inflated.
- Expect wide intervals. With 30 PRs and ~40 labeled risks, a 70% recall is "somewhere between
  roughly 55% and 82%". The report prints Wilson 95% intervals for that reason. Don't claim more
  precision than they allow.
- One rater (you) wrote the labels and judged the flags. Say so. If you can get a friend to label a
  few PRs independently, that is a real improvement.
- Report weak spots. If "semantic" recall is low, say the rules carry most of the value.

## What goes on a resume

Fill the brackets from `report.md`, and only from a report with no DRAFT banner:

- Built and evaluated a GitHub App that reviews pull requests with an LLM: on [N] merged PRs from
  [M] public repos, it caught [X]% of hand-labeled risks ([a]-[b]% 95% CI) at [Y]% precision.
- Rule-based checks alone caught [Z]% of those risks at zero model cost; median [T] s and ~$[C] per
  PR.
