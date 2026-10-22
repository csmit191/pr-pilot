You are helping me build a portfolio project called "PR Pilot": a GitHub App that reviews
pull requests with an LLM. I'm a CS student (rising senior) who knows TypeScript and Node.js
from an internship where I built a commit-tracking web app. Optimize for clean, well-tested,
explainable code over cleverness.

Core features:
1. On pull_request "opened" and "synchronize" webhooks, fetch the diff and post ONE summary
   comment (updated in place on later pushes, never duplicated).
2. Flag risky changes: secrets/credentials, changes to auth or payment code, large diffs,
   deleted tests, dependency changes, migrations. Use deterministic rules first, then the LLM.
3. Suggest reviewers based on CODEOWNERS and on who most recently changed the touched files.

Constraints:
- TypeScript strict mode, Node 20+, Probot or Octokit, Vitest for tests.
- The LLM provider is behind an interface so I can swap providers; API keys come only from
  environment variables and are never logged or committed.
- Verify webhook signatures. Handle diffs too large for the model by chunking or summarizing
  per file.
- Structured LLM output: ask for JSON matching a schema and validate it (zod) before use.

Before writing code for any step, briefly explain your plan and the trade-offs. After
each step, tell me how to run and test it.
