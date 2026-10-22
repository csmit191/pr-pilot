import { describe, expect, it } from "vitest";
import { FILE_SYSTEM_PROMPT, SYSTEM_PROMPT, WITHHELD_NOTE } from "../src/llm/prompt.js";
import { LlmError } from "../src/llm/provider.js";
import { LlmOutputError, summarizePullRequest, type SummarizeInput } from "../src/llm/summarize.js";
import { DEFAULT_CONFIG } from "../src/risk/config.js";
import { scanDiff } from "../src/risk/scan.js";
import type { RiskFlag } from "../src/risk/types.js";
import { fakeProvider, queue, validFileSummary, validReview } from "./fakeProvider.js";
import { addedPatch, makeFile } from "./helpers.js";

const AWS_KEY = "AK" + "IA" + "Q2W3E4R5T6Y7U8I9";

const codeFile = (path: string, lines = 60, extra: Partial<Parameters<typeof makeFile>[0]> = {}) =>
  makeFile({
    path,
    additions: lines,
    patch: addedPatch(...Array.from({ length: lines }, (_, i) => `const value${i} = compute(${i});`)),
    ...extra,
  });

const input = (files = [codeFile("src/login.ts", 3)], flags: RiskFlag[] = [], truncated = false): SummarizeInput => ({
  title: "Add login auditing",
  body: "Writes an audit entry per login.",
  diff: { files, truncated },
  flags,
});

const pathOf = (user: string) => /<file path="([^"]+)"/.exec(user)?.[1] ?? "";

/** Answers per-file calls with a summary naming the file, and the combine call with a review. */
const mapReduceResponder = (onFile?: (path: string) => string | Promise<string>) => async (req: { system: string; user: string }) => {
  if (req.system === FILE_SYSTEM_PROMPT) {
    const path = pathOf(req.user);
    return onFile ? onFile(path) : validFileSummary({ summary: `summary of ${path}` });
  }
  return validReview();
};

// A budget small enough that a few 60-line files overflow it, forcing map-reduce.
const SMALL = { maxInputChars: 3000 };

describe("summarizePullRequest: single pass", () => {
  it("makes one call and returns the validated review", async () => {
    const provider = fakeProvider(queue(validReview()));
    const result = await summarizePullRequest(input(), provider);

    expect(result.mode).toBe("single");
    expect(result.calls).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(result.summary.summary).toBe("Adds audit logging to the login flow.");

    const [req] = provider.requests;
    expect(req?.system).toBe(SYSTEM_PROMPT);
    expect(req?.user).toContain("Add login auditing");
    expect(req?.user).toContain("src/login.ts");
  });

  it("accepts JSON wrapped in code fences", async () => {
    const provider = fakeProvider(queue("```json\n" + validReview() + "\n```"));
    const result = await summarizePullRequest(input(), provider);
    expect(result.calls).toBe(1);
  });

  it("retries once on invalid output, telling the model what was wrong", async () => {
    const provider = fakeProvider(queue("Sorry, here is a summary in prose.", validReview()));
    const result = await summarizePullRequest(input(), provider);

    expect(result.calls).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
    const retry = provider.requests[1]!.user;
    expect(retry).toContain("previous reply was rejected");
    expect(retry).toContain("No JSON object found");
    expect(retry.startsWith(provider.requests[0]!.user)).toBe(true); // original input is preserved
  });

  it("retries on a schema violation and names the offending field", async () => {
    const bad = validReview({ risks: [{ file: "src/login.ts", reason: "x", severity: "urgent" }] });
    const provider = fakeProvider(queue(bad, validReview()));
    await summarizePullRequest(input(), provider);
    expect(provider.requests[1]!.user).toContain("risks.0.severity");
  });

  it("gives up after one retry with LlmOutputError that carries the spent usage", async () => {
    const provider = fakeProvider(queue("nope", "still nope"));
    const err = (await summarizePullRequest(input(), provider).catch((e: unknown) => e)) as LlmOutputError;

    expect(err).toBeInstanceOf(LlmOutputError);
    expect(err.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
    expect(provider.requests).toHaveLength(2); // never a third attempt
  });

  it("does not retry provider failures (the handler decides what to do)", async () => {
    const provider = fakeProvider(() => {
      throw new LlmError("Anthropic API error (HTTP 529, overloaded_error)", 529);
    });
    await expect(summarizePullRequest(input(), provider)).rejects.toThrow("529");
    expect(provider.requests).toHaveLength(1);
  });

  it("replaces risk files the model invented with '(general)'", async () => {
    const reply = validReview({
      risks: [
        { file: "src/login.ts", reason: "Real file", severity: "medium" },
        { file: "made/up.ts", reason: "Invented file", severity: "low" },
      ],
    });
    const result = await summarizePullRequest(input(), fakeProvider(queue(reply)));
    expect(result.summary.risks.map((r) => r.file)).toEqual(["src/login.ts", "(general)"]);
  });

  it("truncates a huge patch and tells the model", async () => {
    const provider = fakeProvider(queue(validReview()));
    await summarizePullRequest(input([codeFile("src/big.ts", 100)]), provider, { maxPatchCharsPerFile: 500 });
    expect(provider.requests[0]!.user).toContain("diff truncated");
  });

  it("tells the model when GitHub's file listing was truncated", async () => {
    const provider = fakeProvider(queue(validReview()));
    await summarizePullRequest(input([codeFile("a.ts", 2)], [], true), provider);
    expect(provider.requests[0]!.user).toContain('listing_truncated="true"');
  });
});

describe("summarizePullRequest: secrets never leave the server", () => {
  const files = [
    makeFile({ path: "src/config.ts", additions: 2, patch: addedPatch(`const awsKey = "${AWS_KEY}";`, "export const region = 'us-east-1';") }),
    codeFile("src/other.ts", 3),
  ];
  const flags = scanDiff({ files, truncated: false }, DEFAULT_CONFIG);

  it("(precondition) the scanner flags the key on a specific line", () => {
    expect(flags.some((f) => f.rule === "secrets" && f.file === "src/config.ts" && f.line === 1)).toBe(true);
  });

  it("withholds the file's diff in single-pass mode", async () => {
    const provider = fakeProvider(queue(validReview()));
    await summarizePullRequest(input(files, flags), provider);
    const sent = provider.requests.map((r) => r.user).join("\n");
    expect(sent).not.toContain(AWS_KEY);
    expect(sent).not.toContain("us-east-1"); // the whole file is withheld, not just the key line
    expect(sent).toContain(WITHHELD_NOTE);
    expect(sent).toContain("src/other.ts"); // other files are unaffected
  });

  it("withholds it in map-reduce mode too, including per-file and combine prompts", async () => {
    const many = [...files, codeFile("src/c.ts"), codeFile("src/d.ts")];
    const provider = fakeProvider(mapReduceResponder());
    const result = await summarizePullRequest(input(many, flags), provider, SMALL);
    expect(result.mode).toBe("map-reduce");
    const sent = provider.requests.map((r) => r.user).join("\n");
    expect(sent).not.toContain(AWS_KEY);
    expect(sent).not.toContain("us-east-1");
  });
});

describe("summarizePullRequest: map-reduce for large PRs", () => {
  it("summarizes each file, then combines", async () => {
    const files = [codeFile("src/a.ts"), codeFile("src/b.ts"), codeFile("src/c.ts")];
    const provider = fakeProvider(mapReduceResponder());
    const result = await summarizePullRequest(input(files), provider, SMALL);

    expect(result.mode).toBe("map-reduce");
    expect(result.calls).toBe(4);
    expect(result.usage).toEqual({ inputTokens: 400, outputTokens: 80 });

    const fileCalls = provider.requests.filter((r) => r.system === FILE_SYSTEM_PROMPT);
    const combine = provider.requests.filter((r) => r.system === SYSTEM_PROMPT);
    expect(fileCalls.map((r) => pathOf(r.user)).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(combine).toHaveLength(1);
    for (const path of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
      expect(combine[0]!.user).toContain(`summary of ${path}`);
    }
    expect(combine[0]!.user).not.toContain("compute("); // raw code is not re-sent in the combine step
  });

  it("summarizes flagged and larger files first when over the file cap, and lists the rest as omitted", async () => {
    const files = [codeFile("src/a.ts", 10), codeFile("src/b.ts", 50), codeFile("src/c.ts", 20), codeFile("src/z-flagged.ts", 5), codeFile("src/d.ts", 30)];
    const flags: RiskFlag[] = [{ rule: "sensitivePaths", severity: "high", reason: "auth", file: "src/z-flagged.ts" }];
    const provider = fakeProvider(mapReduceResponder());
    await summarizePullRequest(input(files, flags), provider, { maxInputChars: 500, maxFilesToSummarize: 2 });

    const fileCalls = provider.requests.filter((r) => r.system === FILE_SYSTEM_PROMPT).map((r) => pathOf(r.user));
    expect(fileCalls.sort()).toEqual(["src/b.ts", "src/z-flagged.ts"]);
    const combine = provider.requests.find((r) => r.system === SYSTEM_PROMPT)!;
    expect(combine.user).toContain('<omitted_files count="3">');
    for (const omitted of ["src/a.ts", "src/c.ts", "src/d.ts"]) expect(combine.user).toContain(omitted);
  });

  it("does not spend a call on files with no diff, but still lists them", async () => {
    const files = [codeFile("src/a.ts"), codeFile("src/b.ts"), makeFile({ path: "package-lock.json", additions: 5000, patch: null })];
    const provider = fakeProvider(mapReduceResponder());
    const result = await summarizePullRequest(input(files), provider, SMALL);

    expect(provider.requests.filter((r) => r.system === FILE_SYSTEM_PROMPT)).toHaveLength(2);
    expect(result.calls).toBe(3);
    expect(provider.requests.at(-1)!.user).toContain("package-lock.json");
  });

  it("carries on when one file's summary call fails at the provider", async () => {
    const files = [codeFile("src/a.ts"), codeFile("src/broken.ts"), codeFile("src/c.ts")];
    const provider = fakeProvider(
      mapReduceResponder((path) => {
        if (path === "src/broken.ts") throw new LlmError("Anthropic API error (HTTP 500)", 500);
        return validFileSummary({ summary: `summary of ${path}` });
      }),
    );
    const result = await summarizePullRequest(input(files), provider, SMALL);

    expect(result.summary.summary).toBeDefined();
    expect(result.calls).toBe(4);
    const combine = provider.requests.at(-1)!;
    expect(combine.user).toContain("(summary unavailable)");
    expect(combine.user).toContain("summary of src/a.ts");
  });

  it("carries on when one file's output stays invalid, and still counts its spent tokens", async () => {
    const files = [codeFile("src/a.ts"), codeFile("src/garbled.ts"), codeFile("src/c.ts")];
    const provider = fakeProvider(mapReduceResponder((path) => (path === "src/garbled.ts" ? "garbage" : validFileSummary())));
    const result = await summarizePullRequest(input(files), provider, SMALL);

    // a: 1, garbled: 2 (original + retry), c: 1, combine: 1
    expect(result.calls).toBe(5);
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 100 });
    expect(provider.requests.at(-1)!.user).toContain("(summary unavailable)");
  });

  it("never runs more per-file calls at once than the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const files = Array.from({ length: 6 }, (_, i) => codeFile(`src/f${i}.ts`));
    const provider = fakeProvider(
      mapReduceResponder(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return validFileSummary();
      }),
    );
    await summarizePullRequest(input(files), provider, { ...SMALL, concurrency: 2 });
    expect(maxInFlight).toBe(2); // parallel, but capped
  });

  it("fails when the final combine step can't produce valid output", async () => {
    const files = [codeFile("src/a.ts"), codeFile("src/b.ts"), codeFile("src/c.ts")];
    const provider = fakeProvider(async (req) => (req.system === FILE_SYSTEM_PROMPT ? validFileSummary() : "not json"));
    await expect(summarizePullRequest(input(files), provider, SMALL)).rejects.toThrow("failed validation");
  });

  it("sanitizes invented file names in the combined result too", async () => {
    const files = [codeFile("src/a.ts"), codeFile("src/b.ts"), codeFile("src/c.ts")];
    const provider = fakeProvider(async (req) =>
      req.system === FILE_SYSTEM_PROMPT
        ? validFileSummary()
        : validReview({ risks: [{ file: "ghost.ts", reason: "?", severity: "low" }] }),
    );
    const result = await summarizePullRequest(input(files), provider, SMALL);
    expect(result.summary.risks[0]?.file).toBe("(general)");
  });
});
