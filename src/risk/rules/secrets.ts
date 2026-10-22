import type { ChangedFile } from "../../diff/types.js";
import type { SecretsRuleConfig } from "../config.js";
import { SECRET_SCAN_SKIP } from "../defaults.js";
import { shannonEntropy } from "../entropy.js";
import { firstMatch } from "../glob.js";
import { addedLines } from "../patch.js";
import type { RiskFlag, Severity } from "../types.js";

export const MAX_SECRET_FLAGS_PER_FILE = 5;

interface SecretPattern {
  name: string;
  regex: RegExp;
}

// Order matters: specific providers before generic ones (sk-ant- before sk-).
const PATTERNS: SecretPattern[] = [
  { name: "AWS access key ID", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { name: "Slack token", regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Stripe live key", regex: /\b[sr]k_live_[0-9a-zA-Z]{24,}/ },
  { name: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI API key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: "private key block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/ },
  {
    name: "JSON Web Token",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
];

// name = "literal", e.g.  apiKey: "abc12345",  SECRET_KEY = 'abc12345'
const ASSIGNMENT =
  /(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|auth[_-]?key|private[_-]?key)\w*\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/i;

const TOKEN = /[A-Za-z0-9+/=_-]{20,}/g;

const PLACEHOLDER = /example|placeholder|changeme|change-me|dummy|fake|redacted|your[_-]|x{4,}|test/i;
const TEMPLATED = /^(?:\$|<|\{\{|%\()/; // ${TOKEN}, $TOKEN, <your-token>, {{ secret }}

const isPlaceholder = (text: string): boolean => PLACEHOLDER.test(text);

function isHighEntropy(token: string, config: SecretsRuleConfig): boolean {
  if (token.length < config.minLength) return false;
  // Pure hex is almost always a commit SHA or checksum, which are everywhere in diffs.
  if (/^[0-9a-f]+$/i.test(token)) return false;
  // Real keys mix letters and digits; this skips long words and numbers.
  if (!/[A-Za-z]/.test(token) || !/[0-9]/.test(token)) return false;
  if (isPlaceholder(token)) return false;
  return shannonEntropy(token) >= config.entropyThreshold;
}

interface Finding {
  severity: Severity;
  reason: string;
}

/** Checks one added line. The reason deliberately never includes the matched text. */
function findSecret(text: string, config: SecretsRuleConfig): Finding | null {
  for (const { name, regex } of PATTERNS) {
    const match = regex.exec(text);
    if (match && !isPlaceholder(match[0])) {
      return { severity: "critical", reason: `Likely ${name} added` };
    }
  }

  const value = ASSIGNMENT.exec(text)?.[1];
  if (value && !isPlaceholder(value) && !TEMPLATED.test(value)) {
    return {
      severity: "high",
      reason: "Possible hardcoded credential assigned to a secret-like name",
    };
  }

  for (const match of text.matchAll(TOKEN)) {
    if (isHighEntropy(match[0], config)) {
      return { severity: "high", reason: "High-entropy string that may be a secret" };
    }
  }
  return null;
}

export function scanSecrets(file: ChangedFile, config: SecretsRuleConfig): RiskFlag[] {
  if (file.status === "removed") return [];
  if (firstMatch(SECRET_SCAN_SKIP, file.path) || firstMatch(config.allowPaths, file.path)) {
    return [];
  }

  if (file.patch === null) {
    // Binary files report 0 additions; an oversized text diff reports many but has no patch.
    if (file.additions > 0) {
      return [
        {
          rule: "secrets",
          severity: "low",
          file: file.path,
          reason: "GitHub did not include a diff for this file (too large), so it was not scanned for secrets",
        },
      ];
    }
    return [];
  }

  const flags: RiskFlag[] = [];
  for (const { line, text } of addedLines(file.patch)) {
    const finding = findSecret(text, config);
    if (!finding) continue;

    // A base64 blob can match on hundreds of lines; say so once instead of flooding the comment.
    if (flags.length === MAX_SECRET_FLAGS_PER_FILE) {
      flags.push({
        rule: "secrets",
        severity: "low",
        file: file.path,
        reason: `More possible secrets found; stopped after ${MAX_SECRET_FLAGS_PER_FILE} in this file`,
      });
      break;
    }
    flags.push({ rule: "secrets", severity: finding.severity, file: file.path, line, reason: finding.reason });
  }
  return flags;
}
