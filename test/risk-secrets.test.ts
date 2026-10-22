import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/risk/config.js";
import { MAX_SECRET_FLAGS_PER_FILE, scanSecrets } from "../src/risk/rules/secrets.js";
import { addedPatch, makeFile } from "./helpers.js";

const cfg = DEFAULT_CONFIG.rules.secrets;

// Fake credentials, assembled from pieces so this file itself never contains a complete
// token (GitHub push protection would otherwise block pushing it).
const AWS = "AK" + "IA" + "Q2W3E4R5T6Y7U8I9";
const AWS_DOC_EXAMPLE = "AK" + "IAIOSFODNN7" + "EXAMPLE";
const HIGH_ENTROPY = "k8Zq2Vx9Lm4Tn7Ws1Yb6Hd3Fg5Jr0Pc8Ua2Ne4Qo";
const SAMPLES: Array<[string, string, string]> = [
  ["AWS access key ID", AWS, "AWS access key ID"],
  ["GitHub token", "gh" + "p_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5", "GitHub token"],
  ["GitHub fine-grained token", "github_" + "pat_" + "11ABCDEFG0abcdefghijkl_MNOPQRSTUV", "GitHub token"],
  ["Slack token", "xo" + "xb-" + "1234567890-abcdefghij12", "Slack token"],
  ["Stripe live key", "sk_" + "live_" + "51HxQ2W3E4R5T6Y7U8I9O0P1A2", "Stripe live key"],
  ["Google API key", "AI" + "za" + "SyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q", "Google API key"],
  ["Anthropic API key", "sk-" + "ant-" + "api03-Ab12Cd34Ef56Gh78Ij90", "Anthropic API key"],
  ["OpenAI API key", "sk-" + "proj-" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90", "OpenAI API key"],
  ["private key block", "-----BEGIN " + "RSA PRIVATE KEY-----", "private key block"],
  [
    "JSON Web Token",
    "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0" + "." + "abcDEF123xyz789Q",
    "JSON Web Token",
  ],
];

const scanLine = (line: string, path = "src/config.ts") =>
  scanSecrets(makeFile({ path, additions: 1, patch: addedPatch(line) }), cfg);

describe("scanSecrets: known key formats", () => {
  it.each(SAMPLES)("detects a %s", (_label, value, expectedName) => {
    const flags = scanLine(`const v = "${value}";`);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toEqual({
      rule: "secrets",
      severity: "critical",
      file: "src/config.ts",
      line: 1,
      reason: `Likely ${expectedName} added`,
    });
    // Flags end up in a public PR comment, so they must never contain the secret itself.
    expect(JSON.stringify(flags)).not.toContain(value);
  });

  it("ignores documented placeholder keys", () => {
    expect(scanLine(`const k = "${AWS_DOC_EXAMPLE}";`)).toEqual([]);
  });

  it("reports one flag per line even if several secrets share it", () => {
    const both = `const a = "${AWS}", b = "gh${"p_"}aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";`;
    expect(scanLine(both)).toHaveLength(1);
  });
});

describe("scanSecrets: line numbers and scope", () => {
  it("reports the real line number in the new file", () => {
    const patch = [
      "@@ -10,3 +10,4 @@",
      " keep one", // 10
      " keep two", // 11
      `+const k = "${AWS}";`, // 12
      " keep three", // 13
      "@@ -40,1 +41,2 @@",
      " ctx", // 41
      `+const j = "${AWS}";`, // 42
    ].join("\n");
    const flags = scanSecrets(makeFile({ path: "a.ts", additions: 2, patch }), cfg);
    expect(flags.map((f) => f.line)).toEqual([12, 42]);
  });

  it("only looks at added lines, not removed or context lines", () => {
    const patch = ["@@ -1,3 +1,2 @@", `-const old = "${AWS}";`, ` const ctx = "${AWS}";`, " keep"].join("\n");
    expect(scanSecrets(makeFile({ path: "a.ts", deletions: 1, patch }), cfg)).toEqual([]);
  });

  it("returns nothing for removed files", () => {
    const file = makeFile({ path: "a.ts", status: "removed", deletions: 1, patch: addedPatch(AWS) });
    expect(scanSecrets(file, cfg)).toEqual([]);
  });
});

describe("scanSecrets: hardcoded credentials", () => {
  it.each([
    'const apiKey = "hunter2hunter2";',
    "password: 'correcthorse'",
    'SECRET_KEY = "s3cr3tvalue99"',
    "const dbPassword = `abcdefgh12`;",
  ])("flags %s", (line) => {
    const flags = scanLine(line);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.severity).toBe("high");
    expect(flags[0]?.reason).toContain("hardcoded credential");
  });

  it.each([
    "const token = process.env.TOKEN;",
    'api_key = "${API_KEY}"',
    'token = "$TOKEN_VALUE"',
    'apiKey: "<your-api-key>"',
    'const secret = "test-secret";',
    'apiKey = "changeme123"',
    'password = "short"',
    "const apiKey: string = getKey();",
  ])("ignores %s", (line) => {
    expect(scanLine(line)).toEqual([]);
  });
});

describe("scanSecrets: high-entropy strings", () => {
  it("flags a long random-looking string", () => {
    const flags = scanLine(`const blob = "${HIGH_ENTROPY}";`);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ severity: "high", line: 1 });
    expect(flags[0]?.reason).toContain("High-entropy");
    expect(JSON.stringify(flags)).not.toContain(HIGH_ENTROPY);
  });

  it("ignores long identifiers, git SHAs, and long hex checksums", () => {
    expect(scanLine('const name = "thisIsAVeryLongDescriptiveVariableName2";')).toEqual([]);
    expect(scanLine('const sha = "9fceb02d0ae598e95dc970b74767f19372d61af8";')).toEqual([]);
    expect(scanLine("const h = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';")).toEqual([]);
  });

  it("ignores long strings with no digits or no letters", () => {
    expect(scanLine(`const s = "${"AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh"}";`)).toEqual([]);
    expect(scanLine(`const n = "${"1234567890123456789012345678901234567890"}";`)).toEqual([]);
  });

  it("respects entropyThreshold in both directions", () => {
    const strict = { ...cfg, entropyThreshold: 5.5 };
    const loose = { ...cfg, entropyThreshold: 4.0 };
    const file = (line: string) => makeFile({ path: "a.ts", additions: 1, patch: addedPatch(line) });

    expect(scanSecrets(file(`x = "${HIGH_ENTROPY}"`), strict)).toEqual([]);
    const identifier = 'const name = "thisIsAVeryLongDescriptiveVariableName2";';
    expect(scanSecrets(file(identifier), cfg)).toEqual([]);
    expect(scanSecrets(file(identifier), loose)).toHaveLength(1);
  });

  it("respects minLength", () => {
    const longer = { ...cfg, minLength: 50 };
    const file = makeFile({ path: "a.ts", additions: 1, patch: addedPatch(`x = "${HIGH_ENTROPY}"`) });
    expect(scanSecrets(file, longer)).toEqual([]);
  });
});

describe("scanSecrets: skipped files and missing patches", () => {
  const integrity =
    '"integrity": "sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=="';

  it("skips lockfiles, snapshots and minified files (path-based, not content-based)", () => {
    expect(scanLine(integrity, "package-lock.json")).toEqual([]);
    expect(scanLine(integrity, "web/__snapshots__/a.snap")).toEqual([]);
    expect(scanLine(integrity, "dist/app.min.js")).toEqual([]);
    expect(scanLine(integrity, "src/other.ts")).toHaveLength(1); // same text elsewhere IS flagged
  });

  it("skips paths in allowPaths", () => {
    const allowed = { ...cfg, allowPaths: ["test/fixtures/**"] };
    const file = makeFile({ path: "test/fixtures/keys.ts", additions: 1, patch: addedPatch(AWS) });
    expect(scanSecrets(file, allowed)).toEqual([]);
    expect(scanSecrets({ ...file, path: "src/keys.ts" }, allowed)).toHaveLength(1);
  });

  it("says so when GitHub omitted the diff of a large text file", () => {
    const flags = scanSecrets(makeFile({ path: "data/big.json", additions: 500, patch: null }), cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ rule: "secrets", severity: "low", file: "data/big.json" });
    expect(flags[0]?.reason).toContain("not scanned");
  });

  it("stays quiet for binaries and for large deletions without a patch", () => {
    expect(scanSecrets(makeFile({ path: "logo.png", status: "added", patch: null }), cfg)).toEqual([]);
    expect(scanSecrets(makeFile({ path: "a.ts", deletions: 400, patch: null }), cfg)).toEqual([]);
  });
});

describe("scanSecrets: flood protection", () => {
  const manyLines = (n: number) =>
    makeFile({
      path: "a.ts",
      additions: n,
      patch: addedPatch(...Array.from({ length: n }, () => `k = "${AWS}"`)),
    });

  it("stops after the per-file cap and adds one summary flag", () => {
    const flags = scanSecrets(manyLines(8), cfg);
    expect(flags).toHaveLength(MAX_SECRET_FLAGS_PER_FILE + 1);
    expect(flags.at(-1)).toMatchObject({ severity: "low" });
    expect(flags.at(-1)?.reason).toContain(`stopped after ${MAX_SECRET_FLAGS_PER_FILE}`);
  });

  it("adds no summary when findings exactly equal the cap", () => {
    const flags = scanSecrets(manyLines(MAX_SECRET_FLAGS_PER_FILE), cfg);
    expect(flags).toHaveLength(MAX_SECRET_FLAGS_PER_FILE);
    expect(flags.every((f) => f.severity === "critical")).toBe(true);
  });
});
