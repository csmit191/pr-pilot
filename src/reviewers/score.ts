import type { ChangedFile } from "../diff/types.js";
import { ownersOf, type CodeownersRule } from "./codeowners.js";
import type { CommitInfo } from "./history.js";

export const SCORING = {
  /**
   * Points for each changed file someone owns via CODEOWNERS. Chosen so ownership always beats
   * history: history can add at most perFileCap (2) x MAX_HISTORY_FILES (8) = 16 points.
   */
  ownerPointsPerFile: 100,
  /** A commit's weight halves every this many days. */
  halfLifeDays: 90,
  /** One person can earn at most this many history points from a single file. */
  perFileCap: 2,
  maxReviewers: 3,
} as const;

export interface ReviewerSuggestion {
  /** "alice" or, for teams, "acme/platform". */
  handle: string;
  kind: "user" | "team";
  score: number;
  /** Changed files this person/team owns according to CODEOWNERS. */
  ownedFiles: number;
  /** Changed files they committed to recently. */
  recentFiles: number;
  /** Human-readable explanation of the score. */
  reasons: string[];
}

export interface ScoreInput {
  /** Login of the PR author, who is never suggested. */
  author: string;
  files: readonly ChangedFile[];
  rules: readonly CodeownersRule[];
  /** Recent commits per changed file path (keyed by ChangedFile.path). */
  history: ReadonlyMap<string, readonly CommitInfo[]>;
  now: Date;
  max?: number;
}

interface Candidate {
  handle: string;
  kind: "user" | "team";
  ownedFiles: Set<string>;
  recentFiles: number;
  historyScore: number;
}

const MS_PER_DAY = 86_400_000;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const isBotLogin = (login: string): boolean => login.toLowerCase().endsWith("[bot]");
const plural = (n: number): string => `${n} changed file${n === 1 ? "" : "s"}`;

/**
 * Ranks reviewer candidates.
 *
 *   score = 100 x (changed files they own in CODEOWNERS)
 *         + sum over changed files of min(2, sum of 0.5^(commitAgeDays / 90) over their commits)
 *
 * Pure function: no I/O, `now` is passed in, so it is easy to test.
 */
export function scoreReviewers(input: ScoreInput): ReviewerSuggestion[] {
  const { author, files, rules, history, now, max = SCORING.maxReviewers } = input;
  const authorKey = author.toLowerCase();
  const candidates = new Map<string, Candidate>();

  const eligibleUser = (login: string): boolean => login.toLowerCase() !== authorKey && !isBotLogin(login);

  const candidate = (kind: "user" | "team", handle: string): Candidate => {
    const key = `${kind}:${handle.toLowerCase()}`; // GitHub logins are case-insensitive
    let entry = candidates.get(key);
    if (!entry) {
      entry = { handle, kind, ownedFiles: new Set(), recentFiles: 0, historyScore: 0 };
      candidates.set(key, entry);
    }
    return entry;
  };

  // 1) CODEOWNERS. A renamed file is owned by whoever owned it before as well as after.
  for (const file of files) {
    const owners = [
      ...ownersOf(rules, file.path),
      ...(file.previousPath ? ownersOf(rules, file.previousPath) : []),
    ];
    for (const owner of owners) {
      if (owner.kind === "email") continue; // can't map an email to a GitHub login
      if (owner.kind === "user" && !eligibleUser(owner.handle)) continue;
      candidate(owner.kind, owner.handle).ownedFiles.add(file.path);
    }
  }

  // 2) Recent history, one file at a time so a single hot file can't dominate.
  for (const file of files) {
    const perAuthor = new Map<string, { login: string; weight: number }>();
    for (const commit of history.get(file.path) ?? []) {
      const login = commit.authorLogin;
      if (login === null || commit.authorIsBot || !eligibleUser(login)) continue;

      const time = Date.parse(commit.date);
      if (Number.isNaN(time)) continue;

      const ageDays = Math.max(0, (now.getTime() - time) / MS_PER_DAY); // clock skew: never negative
      const weight = 0.5 ** (ageDays / SCORING.halfLifeDays);

      const key = login.toLowerCase();
      const entry = perAuthor.get(key) ?? { login, weight: 0 };
      entry.weight += weight;
      perAuthor.set(key, entry);
    }
    for (const { login, weight } of perAuthor.values()) {
      const entry = candidate("user", login);
      entry.historyScore += Math.min(weight, SCORING.perFileCap);
      entry.recentFiles += 1;
    }
  }

  const suggestions = [...candidates.values()].map((c): ReviewerSuggestion => {
    const ownedFiles = c.ownedFiles.size;
    const reasons: string[] = [];
    if (ownedFiles > 0) reasons.push(`owns ${plural(ownedFiles)} (CODEOWNERS)`);
    if (c.recentFiles > 0) reasons.push(`recently committed to ${plural(c.recentFiles)}`);
    return {
      handle: c.handle,
      kind: c.kind,
      score: round2(ownedFiles * SCORING.ownerPointsPerFile + c.historyScore),
      ownedFiles,
      recentFiles: c.recentFiles,
      reasons,
    };
  });

  return suggestions
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle))
    .slice(0, max);
}
