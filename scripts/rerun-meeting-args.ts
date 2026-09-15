/**
 * What `bun run meeting:rerun` was asked to do, and the two refusals it makes
 * before it opens anything.
 *
 * SEPARATE FROM THE RUN because both refusals are the point of the harness
 * and neither can be tested through a run: the spend flag has to be judged
 * before a server exists, and the budget has to be judged before a socket
 * does. A test that had to hold a meeting to find out whether the guard fires
 * would be a test nobody runs.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import {
  DEFAULT_NOTES_METHOD,
  type NotesMethod,
  notesMethodInfo,
  parseNotesMethod,
} from '../packages/core/src/notes-method.ts';

export const RERUN_ENGINES = ['mock', 'soniox', 'assemblyai', 'assemblyai-pro'] as const;
export type RerunEngine = (typeof RERUN_ENGINES)[number];

export const USAGE = `usage: bun run meeting:rerun <meeting folder | segment-N-<stream>.pcm> --spend-usd <max> [options]

  --spend-usd <max>   REQUIRED. The ceiling, in dollars, this run may bill.
                      There is no default: this harness runs the real
                      note-taker over the whole length of a recording, and a
                      harness that can start without somebody naming a number
                      is one that quietly bills for an afternoon.
  --method <m>        original | ledger-haiku | ledger-opus (default original)
  --engine <name>     mock | soniox | assemblyai | assemblyai-pro (default mock).
                      Retained audio carries no words on its own — something
                      has to hear it. \`mock\` is free and reads --mock-script.
  --mock-script <f>   JSON array of { words: string[], settled?, speaker? } for
                      the mock engine, which reveals one word per audio chunk.
  --engine-spend-ok   REQUIRED with any engine but \`mock\`. A paid engine bills
                      the vendor for the audio's whole length, on their price
                      list and not through any seam this harness can meter, so
                      --spend-usd cannot and does not cover it. This flag is
                      you saying you know that.
  --doc <shape>       empty (default) | <file.md> | <file.json>. The .json is
                      { markdown, edits: [{ atMs, find, replace }] } — a prep
                      outline a person edits while the meeting runs.
  --out <dir>         Where the run folder goes (default ./meeting-reruns).
  --chunk-ms <ms>     Audio per send (default 20, what the browser sends).
                      With --engine mock this also sets the word rate: one
                      word per chunk, so 400 is about conversational speed.
  --segment <N>       Only this segment of the meeting folder.
  --mode <m>          solo | conversation (default: what the original asked).
  --port <n>          Bind the harness server here (default: an ephemeral one).
  --keep              Keep the throwaway data dir.

It is not a gate. It calls a real model for every tick of a real recording,
so nothing in \`bun run verify\` runs it and nothing should add it.`;

export class UsageError extends Error {}

/** One edit a person makes to the starting document while the meeting runs. */
export interface DocEdit {
  /** Milliseconds after the audio starts. */
  atMs: number;
  /** Plain text to find — the same match `find_and_replace` makes. */
  find: string;
  replace: string;
}

/**
 * The document the meeting starts against.
 *
 * THE FAULT THIS HARNESS EXISTS FOR IS ABOUT STRUCTURE — a meeting that wrote
 * 192 bullets and no topic heading — so holding the audio fixed and moving
 * only this is what isolates it. The three shapes are the three a real
 * meeting arrives at: nothing written yet, somebody's prep outline, and an
 * outline being edited while the room talks.
 */
export interface DocSpec {
  shape: 'empty' | 'outline' | 'outline+edits';
  markdown: string;
  edits: DocEdit[];
}

export interface RerunArgs {
  target: string;
  /** The operator said out loud that a paid engine's bill is outside
   *  `--spend-usd`. Only ever true when they typed it. */
  engineSpendOk: boolean;
  method: NotesMethod;
  engine: RerunEngine;
  mockScript?: string;
  doc: string;
  out: string;
  spendUsd: number;
  chunkMs: number;
  segment?: number;
  mode?: 'solo' | 'conversation';
  port: number;
  keep: boolean;
}

function positive(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number`);
  return n;
}

export function parseRerunArgs(argv: readonly string[]): RerunArgs {
  let target: string | undefined;
  let method: NotesMethod = DEFAULT_NOTES_METHOD;
  let engine: RerunEngine = 'mock';
  let mockScript: string | undefined;
  let doc = 'empty';
  let out = 'meeting-reruns';
  let spendUsd: number | undefined;
  let chunkMs = 20;
  let segment: number | undefined;
  let mode: 'solo' | 'conversation' | undefined;
  let port = 0;
  let keep = false;
  let engineSpendOk = false;
  const next = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--spend-usd') spendUsd = positive(a, next(a, i++));
    else if (a === '--method') {
      const m = parseNotesMethod(next(a, i++));
      if (!m) throw new UsageError('--method is original, ledger-haiku or ledger-opus');
      method = m;
    } else if (a === '--engine') {
      const e = next(a, i++);
      if (!(RERUN_ENGINES as readonly string[]).includes(e)) {
        throw new UsageError(`unknown engine ${e}; one of ${RERUN_ENGINES.join(', ')}`);
      }
      engine = e as RerunEngine;
    } else if (a === '--mock-script') mockScript = next(a, i++);
    else if (a === '--engine-spend-ok') engineSpendOk = true;
    else if (a === '--doc') doc = next(a, i++);
    else if (a === '--out') out = next(a, i++);
    else if (a === '--chunk-ms') chunkMs = positive(a, next(a, i++));
    else if (a === '--segment') {
      const n = Number(next(a, i++));
      if (!Number.isInteger(n) || n < 1)
        throw new UsageError('--segment must be a positive integer');
      segment = n;
    } else if (a === '--mode') {
      const m = next(a, i++);
      if (m !== 'solo' && m !== 'conversation')
        throw new UsageError('--mode is solo or conversation');
      mode = m;
    } else if (a === '--port') {
      const n = Number(next(a, i++));
      if (!Number.isInteger(n) || n < 0) throw new UsageError('--port must be a port number');
      port = n;
    } else if (a === '--keep') keep = true;
    else if (a === '--help' || a === '-h') throw new UsageError(USAGE);
    else if (a.startsWith('--')) throw new UsageError(`unknown flag ${a}`);
    else if (target === undefined) target = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (!target) throw new UsageError('a meeting folder or audio file is required');
  // THE SECOND REFUSAL, and it is second because it is a different bill. A
  // paid engine charges the vendor's per-hour rate for the audio's whole
  // length, through no seam this harness can see: `--spend-usd` meters the
  // model calls and would go on reading well under its ceiling while the
  // transcription ran up its own. Rather than invent a price for somebody
  // else's price list, the run refuses until the operator says they know.
  if (engine !== 'mock' && !engineSpendOk) {
    throw new UsageError(
      `refusing to start: --engine ${engine} bills the vendor for the whole length of the ` +
        'recording, and --spend-usd does not cover it — it meters the model calls this ' +
        'harness makes. Pass --engine-spend-ok to say you know that, or use --engine mock.',
    );
  }
  // THE REFUSAL. Last, so that a command line with several things wrong still
  // says this one — it is the one that costs money.
  if (spendUsd === undefined) {
    throw new UsageError(
      'refusing to start: --spend-usd <max> is required.\n' +
        'This harness runs the real note-taker over the whole length of the recording ' +
        'and bills for every tick. Name the most you are willing to spend.',
    );
  }
  return {
    target,
    method,
    engine,
    doc,
    out,
    spendUsd,
    chunkMs,
    port,
    keep,
    engineSpendOk,
    ...(mockScript !== undefined ? { mockScript } : {}),
    ...(segment !== undefined ? { segment } : {}),
    ...(mode ? { mode } : {}),
  };
}

/**
 * How much more than the compose alone a meeting bills.
 *
 * `estimatedPerHourUsd` is the compose call and nothing else, and a live
 * meeting also pays for task capture on every tick — the half that was
 * invisible until it was measured at roughly as much again as the compose
 * (`notes-spend.ts`). An estimate used to REFUSE a run has to be the high
 * one: a guard that under-reads lets exactly the run it exists to stop
 * through.
 */
export const CAPTURE_OVERHEAD = 2;

export interface BudgetVerdict {
  ok: boolean;
  estimateUsd: number;
  line: string;
}

/**
 * Would this recording, on this method, plausibly cost more than the ceiling?
 *
 * Judged BEFORE the socket opens, from the audio's own length, because the
 * only number available afterwards is the bill. It is an estimate and says so
 * — the live cap in the run is what actually stops a meeting mid-flight — but
 * an estimate is what turns "I typed the wrong folder" into a refusal rather
 * than into an hour of Opus.
 */
export function budgetCheck(audioMs: number, method: NotesMethod, maxUsd: number): BudgetVerdict {
  const hours = audioMs / 3_600_000;
  const estimateUsd = hours * notesMethodInfo(method).estimatedPerHourUsd * CAPTURE_OVERHEAD;
  const shape =
    `${(audioMs / 60_000).toFixed(1)} min of audio on ${method} ≈ $${estimateUsd.toFixed(2)} ` +
    // The ceiling keeps its small digits: a $0.001 ceiling printed as $0.00
    // reads as a ceiling of nothing, which is a different mistake.
    `(compose estimate ×${CAPTURE_OVERHEAD} for capture), ceiling $${maxUsd.toFixed(maxUsd < 0.01 ? 4 : 2)}`;
  return estimateUsd > maxUsd
    ? { ok: false, estimateUsd, line: `refusing to start: ${shape}` }
    : { ok: true, estimateUsd, line: shape };
}

/**
 * Every mid-run edit has to land while the audio is still playing.
 *
 * An edit scheduled past the end is not a late edit — it is no edit at all:
 * the run stops its timers when the last chunk is sent, so the document the
 * report describes never carried the change, and nothing said so. Caught
 * before the meeting opens, where it is still a command line to fix.
 */
export function checkDocEdits(edits: readonly DocEdit[], audioMs: number): void {
  const late = edits.filter((e) => e.atMs >= audioMs);
  if (late.length === 0) return;
  throw new UsageError(
    `refusing to start: --doc schedules ${late.length} edit(s) at ` +
      `${late.map((e) => `${(e.atMs / 1000).toFixed(1)}s`).join(', ')}, but the recording is ` +
      `${(audioMs / 1000).toFixed(1)}s long — they would never be applied.`,
  );
}

/** How long a PCM file plays for, at the sample rate its meeting recorded. */
export function pcmDurationMs(bytes: number, sampleRate: number): number {
  return (bytes / (sampleRate * 2)) * 1000;
}

/**
 * The starting document, read off whatever `--doc` named.
 *
 * `empty` is the word rather than a path so the common case needs no file,
 * and the two file forms are told apart by extension rather than by sniffing
 * — a `.json` that will not parse is an error worth saying out loud, not a
 * markdown document that happens to start with a brace.
 */
export function loadDocSpec(arg: string, read: (p: string) => string = readFileSyncUtf8): DocSpec {
  if (arg === 'empty') return { shape: 'empty', markdown: '', edits: [] };
  if (!existsSync(arg) || !statSync(arg).isFile()) {
    throw new UsageError(`--doc ${arg} is neither "empty" nor a file`);
  }
  const ext = extname(arg).toLowerCase();
  if (ext === '.md') return { shape: 'outline', markdown: read(arg), edits: [] };
  if (ext !== '.json') throw new UsageError(`--doc ${arg} must be a .md or .json file`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(arg));
  } catch (err) {
    throw new UsageError(
      `--doc ${arg} is not valid JSON: ${err instanceof Error ? err.message : ''}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new UsageError(`--doc ${arg} must hold an object with a markdown field`);
  }
  const row = parsed as { markdown?: unknown; edits?: unknown };
  if (typeof row.markdown !== 'string') {
    throw new UsageError(`--doc ${arg} must hold a string markdown field`);
  }
  const edits: DocEdit[] = [];
  for (const entry of Array.isArray(row.edits) ? row.edits : []) {
    const e = entry as { atMs?: unknown; find?: unknown; replace?: unknown };
    if (typeof e.atMs !== 'number' || !Number.isFinite(e.atMs) || e.atMs < 0) {
      throw new UsageError(`--doc ${arg}: every edit needs a non-negative atMs`);
    }
    if (typeof e.find !== 'string' || e.find.length === 0) {
      throw new UsageError(`--doc ${arg}: every edit needs a non-empty find`);
    }
    if (typeof e.replace !== 'string') {
      throw new UsageError(`--doc ${arg}: every edit needs a replace string`);
    }
    edits.push({ atMs: e.atMs, find: e.find, replace: e.replace });
  }
  edits.sort((a, b) => a.atMs - b.atMs);
  return { shape: edits.length > 0 ? 'outline+edits' : 'outline', markdown: row.markdown, edits };
}

function readFileSyncUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}
