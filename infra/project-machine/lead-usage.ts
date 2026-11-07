#!/usr/bin/env bun
/**
 * The lead's status line command, and the shape of the reading it leaves.
 *
 * Claude Code hands a status line command a JSON object on stdin. Its
 * documented `rate_limits` field (`five_hour` and `seven_day`, each with
 * `used_percentage` and `resets_at`, in seconds) is the only documented
 * source of an account's usage, so this keeps those numbers in
 * `$CW_LEAD_ROOT/usage.json` for `machine:tokens usage` to read, with the
 * listed token's label. Nothing else from stdin is kept.
 *
 * UNPROVEN: the docs do not say whether `rate_limits` appears for a session
 * signed in with `CLAUDE_CODE_OAUTH_TOKEN`, and they say it comes only on
 * Pro, Max and Ultra plans and only after the session's first answer. So the
 * file records `seenAt` on every run, with or without numbers, and the first
 * real machine answers the question: `seenAt` with no `readAt`, after the
 * session's first answer, means the status line ran and no numbers came.
 *
 * It runs on every status update, so it imports nothing heavy.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A listed token's label. `entrypoint.sh` parses the same shape out of the marker. */
export const TOKEN_LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface UsageWindow {
  usedPercent: number;
  /** Seconds since the epoch. */
  resetsAt: number;
}

export interface UsageFile {
  /** The listed token this reading belongs to; '' for a project's own sign-in. */
  label: string;
  /** When the status line last ran, in ms. */
  seenAt: number;
  /** When numbers last came, in ms, or null if none has. */
  readAt: number | null;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Past any real reading and still a date `Date` can hold: seconds for `resetsAt`, ms for the rest. */
const MAX_SECONDS = 1e11;
const MAX_MS = 1e14;
const inRange = (v: unknown, max: number): v is number => isNumber(v) && v >= 0 && v <= max;
const validLabel = (v: unknown): v is string =>
  typeof v === 'string' && (v === '' || TOKEN_LABEL.test(v));

function windowOf(v: unknown): UsageWindow | null {
  const w = v as { used_percentage?: unknown; resets_at?: unknown } | null | undefined;
  if (!isNumber(w?.used_percentage) || !isNumber(w?.resets_at)) return null;
  return { usedPercent: w.used_percentage, resetsAt: w.resets_at };
}

/** The next reading. An update with no numbers keeps the last ones of the same token. */
export function foldUsage(
  before: UsageFile | null,
  input: unknown,
  label: string,
  now: number,
): UsageFile {
  const limits = (input as { rate_limits?: { five_hour?: unknown; seven_day?: unknown } } | null)
    ?.rate_limits;
  const fiveHour = windowOf(limits?.five_hour);
  const sevenDay = windowOf(limits?.seven_day);
  const kept = before?.label === label ? before : null;
  return {
    label,
    seenAt: now,
    readAt: fiveHour || sevenDay ? now : (kept?.readAt ?? null),
    fiveHour: fiveHour ?? kept?.fiveHour ?? null,
    sevenDay: sevenDay ?? kept?.sevenDay ?? null,
  };
}

function storedWindow(v: unknown): UsageWindow | null | undefined {
  if (v === null) return null;
  const w = v as Partial<UsageWindow> | undefined;
  if (!inRange(w?.usedPercent, 1000) || !inRange(w?.resetsAt, MAX_SECONDS)) return undefined;
  return { usedPercent: w.usedPercent, resetsAt: w.resetsAt };
}

/**
 * A reading, or null for anything else. The file is the lead's to write, so a
 * steered lead can put anything in it: only a label and numbers come out.
 */
export function parseUsageFile(raw: string): UsageFile | null {
  let v: Partial<UsageFile> | null;
  try {
    v = JSON.parse(raw) as Partial<UsageFile> | null;
  } catch {
    return null;
  }
  if (!v || !validLabel(v.label) || !inRange(v.seenAt, MAX_MS)) return null;
  if (v.readAt !== null && !inRange(v.readAt, MAX_MS)) return null;
  const fiveHour = storedWindow(v.fiveHour);
  const sevenDay = storedWindow(v.sevenDay);
  if (fiveHour === undefined || sevenDay === undefined) return null;
  return { label: v.label, seenAt: v.seenAt, readAt: v.readAt, fiveHour, sevenDay };
}

export const percent = (n: number): string => `${Math.floor(n)}%`;

function main(stdin: string): void {
  let input: unknown = null;
  try {
    input = JSON.parse(stdin);
  } catch {
    // A status line that fails shows nothing; the lead goes on.
  }
  const root = process.env.CW_LEAD_ROOT ?? '';
  const raw = process.env.CW_LEAD_TOKEN_LABEL ?? '';
  const label = validLabel(raw) ? raw : '';
  const file = join(root, 'usage.json');
  let before: UsageFile | null = null;
  try {
    before = parseUsageFile(readFileSync(file, 'utf8'));
  } catch {
    // No reading yet.
  }
  const next = foldUsage(before, input, label, Date.now());
  if (root) {
    const part = `${file}.${process.pid}`;
    writeFileSync(part, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    renameSync(part, file);
  }
  const parts = [
    label,
    next.fiveHour ? `5h ${percent(next.fiveHour.usedPercent)}` : '',
    next.sevenDay ? `7d ${percent(next.sevenDay.usedPercent)}` : '',
  ];
  console.log(parts.filter(Boolean).join(' '));
}

if (import.meta.main) {
  try {
    main(await Bun.stdin.text());
  } catch {
    process.exit(0);
  }
}
