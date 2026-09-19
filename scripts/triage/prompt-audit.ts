/**
 * The gate on `doc-triage-prompt.md`: which verbs the daily doc-triage job may
 * put in front of an owner.
 *
 * The job's whole output is messages telling other agents what to call. A verb
 * named there is a verb somebody runs on a tired morning without reading the
 * tool description, so the prompt is the last place the choice is made. On
 * 2026-09-19 the prompt still told owners to clean a bound folder up with a
 * board-delete verb, which by then permanently destroyed a whole board with its
 * tasks and history; a peer ran the board-archive verb on a folder id the sweep
 * had offered it, and only a 404 stopped it, because a folder id is not a board
 * id. The remedy is not a warning in the prompt — it is that the destructive
 * spellings do not appear in it at all, so an agent reading it cannot reach for
 * one. Project rule: never hard delete user content, soft delete.
 *
 * This module holds the banned list and the scan; `prompt-audit.test.ts` drives
 * it over the real prompt and over synthetic text. Reading the prompt is
 * reading the artifact under test, not reading source to guess at behaviour:
 * the prompt IS the shipped instruction, and there is nothing else to drive.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The prompt the launchd job feeds to its headless Claude run. */
export const TRIAGE_PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'doc-triage-prompt.md',
);

/**
 * What the prompt may never say, and why each one is here.
 *
 * `pattern` is matched case-insensitively. The verb names are whole tokens; an
 * override flag is matched as a standalone word, so `enforces` and `reinforce`
 * do not trip it.
 */
export const BANNED: ReadonlyArray<{ pattern: RegExp; token: string; why: string }> = [
  {
    token: 'delete_workspace',
    pattern: /delete_workspace/i,
    why: 'permanently destroys a whole board, its tasks and its history',
  },
  {
    token: 'archive_workspace',
    pattern: /archive_workspace/i,
    why: 'stands a whole board down; this job triages docs and attachment sets, never boards',
  },
  {
    token: 'delete_doc',
    pattern: /delete_doc/i,
    why: 'destroys a doc and the comment threads on it; archive_doc is the reversible verb',
  },
  {
    token: 'force',
    pattern: /\bforce\b/i,
    why: 'names the override that pushes a refusal through, which this job must never coach',
  },
];

/** One place the prompt says something it may not. */
export interface Finding {
  /** The banned token, as `BANNED` spells it. */
  token: string;
  /** Why it is banned — carried through so a failure explains itself. */
  why: string;
  /** 1-based line number in the scanned text. */
  line: number;
  /** The offending line, trimmed, for the failure message. */
  text: string;
}

/**
 * Every banned token in `text`, one finding per line per token.
 *
 * Exported separately from the file read so the test can drive it over text it
 * builds itself — a scan that never fires proves nothing, so the suite feeds it
 * a positive control as well as the real prompt.
 */
export function bannedTokensIn(text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    for (const { pattern, token, why } of BANNED) {
      if (pattern.test(line)) {
        findings.push({ token, why, line: index + 1, text: line.trim() });
      }
    }
  }
  return findings;
}

/** The prompt as it sits on disk. */
export function readTriagePrompt(): string {
  return readFileSync(TRIAGE_PROMPT_PATH, 'utf8');
}

/** A failure message naming every finding, for the test and for a CLI run. */
export function describeFindings(findings: Finding[]): string {
  return findings.map((f) => `line ${f.line}: "${f.token}" — ${f.why}\n    ${f.text}`).join('\n');
}
