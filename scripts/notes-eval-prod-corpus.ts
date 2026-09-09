#!/usr/bin/env bun
/**
 * Turn this machine's OWN recorded meetings into an eval corpus — outside the
 * repo, and staying there.
 *
 *   bun run scripts/notes-eval-prod-corpus.ts --out <dir>
 *   bun run scripts/notes-eval-prod-corpus.ts --out <dir> --meeting d-XXXX
 *
 * WHY THIS EXISTS. The committed corpus is AMI: four strangers designing a
 * remote control to a script. It is real speech and it is not this product's
 * speech — no board rows anybody here recognises, no half-finished thought
 * from last week, none of the vocabulary a note-taker has to get right for
 * Bryan specifically. The lost-idea rate over AMI alone would be a number
 * about AMI.
 *
 * WHY IT NEVER TOUCHES THE WORKING TREE. These are real meetings between real
 * people. `--out` is required, it must be outside the repo, and this refuses
 * to write anywhere inside it — a refusal rather than a warning, because the
 * failure mode is a commit. Nothing here prints a line of speech either:
 * the summary is meeting ids and counts.
 *
 * The transcripts are the server's own record:
 * `<dataDir>/meetings/<docId>/<meetingId>.jsonl`, one settled turn per line.
 * Ticks are cut by the live pipeline's own two clocks, exactly as
 * `notes-eval-fixtures.ts` cuts AMI, so a fixture tick holds what a real tick
 * held.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_NOTES_CADENCE_MS,
  DEFAULT_NOTES_QUIET_MS,
} from '../packages/server/src/meeting-notes.ts';
import type { FixtureTick, FixtureTurn, NotesEvalFixture } from './notes-eval-fixtures.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the server keeps its meetings, unless `CW_DATA_DIR` says otherwise. */
export function defaultDataDir(): string {
  return (
    process.env.CW_DATA_DIR ??
    join(homedir(), 'Library', 'Application Support', 'claude-workspaces', 'data')
  );
}

/** One settled turn as the record stores it. */
interface RecordedTurn {
  turn?: number;
  text?: string;
  ts?: number;
  speaker?: string;
}

/**
 * A meeting's turns cut into ticks by the pause clock and the cadence ceiling.
 *
 * The record keeps a wall-clock stamp per turn and no duration, so the gap
 * between two turns is the only pause this can see — which is the same signal
 * the live ticker fires on. A meeting whose stamps do not advance falls into
 * one tick, which is what a run of speech with no pause in it really is.
 */
export function ticksOfRecord(
  turns: readonly RecordedTurn[],
  quietMs: number = DEFAULT_NOTES_QUIET_MS,
  cadenceMs: number = DEFAULT_NOTES_CADENCE_MS,
): FixtureTick[] {
  const ticks: FixtureTick[] = [];
  let current: FixtureTurn[] = [];
  let openedAt = 0;
  let previous: number | null = null;
  const flush = (): void => {
    if (current.length > 0) ticks.push({ turns: current });
    current = [];
  };
  for (const raw of turns) {
    const text = (raw.text ?? '').trim();
    const ts = raw.ts ?? 0;
    if (!text) continue;
    if (current.length > 0 && previous !== null && ts - previous >= quietMs) flush();
    if (current.length === 0) openedAt = ts;
    current.push({ speaker: raw.speaker ?? 'A', text });
    previous = ts;
    if (ts - openedAt >= cadenceMs) flush();
  }
  flush();
  return ticks;
}

function meetingFiles(dataDir: string, docId: string): string[] {
  const dir = join(dataDir, 'meetings', docId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') && f.startsWith('m-'))
    .map((f) => join(dir, f))
    .sort();
}

function readTurns(path: string): RecordedTurn[] {
  const out: RecordedTurn[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as RecordedTurn;
      if (typeof row.text === 'string') out.push(row);
    } catch {
      // A truncated last line is what an append-only record looks like while
      // it is being written. Skipping it costs one turn; throwing costs the
      // meeting.
    }
  }
  return out;
}

/** The fewest ticks a meeting needs before it is worth measuring. */
const MIN_TICKS = 4;

function main(argv: string[]): number {
  const outAt = argv.indexOf('--out');
  const out = outAt >= 0 ? argv[outAt + 1] : undefined;
  if (!out) {
    console.error('--out <dir> is required, and must be outside this repo.');
    return 2;
  }
  const outDir = resolve(out);
  const inside = relative(REPO_ROOT, outDir);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    console.error(
      `Refusing to write inside the repo (${outDir}). These are real meetings between\n` +
        'real people; the corpus lives outside the working tree so it cannot be committed.',
    );
    return 2;
  }
  const dataAt = argv.indexOf('--data-dir');
  const dataDir = dataAt >= 0 && argv[dataAt + 1] ? argv[dataAt + 1]! : defaultDataDir();
  const only = argv.indexOf('--meeting');
  const wanted = only >= 0 && argv[only + 1] ? [argv[only + 1]!] : [];

  const root = join(dataDir, 'meetings');
  if (!existsSync(root)) {
    console.error(`No meetings under ${root}.`);
    return 2;
  }
  mkdirSync(outDir, { recursive: true });
  let written = 0;
  let ticks = 0;
  for (const docId of readdirSync(root).sort()) {
    for (const file of meetingFiles(dataDir, docId)) {
      const id =
        file
          .split('/')
          .pop()
          ?.replace(/\.jsonl$/, '') ?? docId;
      // `--meeting` names the MEETING (the jsonl's stem), as the usage says —
      // never the doc directory it sits in, which is a different id.
      if (wanted.length > 0 && !wanted.includes(id)) continue;
      const cut = ticksOfRecord(readTurns(file));
      if (cut.length < MIN_TICKS) continue;
      const fixture: NotesEvalFixture = {
        meeting: id,
        corpus: 'claude-workspaces production meetings',
        licence: 'private — not for distribution',
        source: 'this machine',
        window: { fromSeconds: 0, seconds: 0 },
        board: [],
        ticks: cut,
      };
      writeFileSync(join(outDir, `${id}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
      written++;
      ticks += cut.length;
      // The id and the counts. Never a line of what was said — not here, not
      // in a log, not in a report built from this output.
      console.log(`${id}: ${cut.length} ticks`);
    }
  }
  console.log(`\n${written} meeting(s), ${ticks} ticks -> ${outDir}`);
  console.log('Next: bun run scripts/notes-eval-ideas.ts --build --corpus', outDir);
  console.log('Then:  bun run notes:eval --corpus', outDir);
  return written === 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
