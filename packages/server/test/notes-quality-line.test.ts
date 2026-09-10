/**
 * The end-of-meeting line, driven through a whole scripted meeting.
 *
 * THE FAILURE THIS FILE IS ABOUT. The line said every settled turn had
 * reached a note — and it was true — while the notes it was reporting on
 * carried the same bullet four times and a name for a voice the room never
 * had. Both facts belong on one line, because a reader who has to join two
 * of them will not, so this drives a real meeting and reads the line the
 * process actually printed.
 *
 * The console is captured rather than mocked away: the line IS the product
 * here, and asserting on a return value would pass while nothing was ever
 * printed.
 *
 * All notes and all speech are invented and every name is fictional. The
 * repo is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Ref, TaskReviewItem } from '@claude-workspaces/core';
import type { Task } from '@claude-workspaces/core/task-wire';
import { createNotesHeadingMemory } from '../src/meeting-notes-doc.ts';
import { meetingTranscriptPath } from '../src/meetings.ts';
import type { NotesQualityBoard } from '../src/notes-quality-review.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

const dirs: string[] = [];
const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-quality-line-'));
  dirs.push(dir);
  return dir;
};

/** The settled turns a meeting left on disk, as the relay writes them. */
function writeTranscript(dataDir: string, docId: string, meetingId: string, texts: string[]): void {
  const path = meetingTranscriptPath(dataDir, docId, meetingId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${texts.map((text, i) => JSON.stringify({ turn: i, text, ts: 1_000 + i })).join('\n')}\n`,
  );
}

/** Everything the process printed while `run` was running. */
async function captureLog(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const take = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  console.log = take;
  console.error = take;
  try {
    await run();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return lines;
}

/** The one line a meeting ends with. */
const summaryLine = (lines: string[], meetingId: string): string =>
  lines.find((l) => l.includes(`meeting ${meetingId}:`)) ?? '';

function recordingBoard(rows: Task[]): NotesQualityBoard & { filed: string[] } {
  const filed: string[] = [];
  return {
    filed,
    backlinksFor: (_ref: Ref) => rows,
    addReviewItem: (taskId) => {
      filed.push(taskId);
      return { ok: true as const, task: rows[0] as Task, item: { id: 'ri-1' } as TaskReviewItem };
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the end-of-meeting line', () => {
  it('carries the quality counts beside the coverage counts, on one line', async () => {
    const dataDir = freshDir();
    writeTranscript(dataDir, 'd-meeting', 'm-clean', [
      'The harbour run moves to the half hour from Monday.',
      'The slipway signage boards need replacing before the season.',
    ]);
    const harness = createNotesTickHarness({
      meetingId: 'm-clean',
      dataDir,
      compose: (input) => addNotes(input, '- The harbour run moves to the half hour'),
    });
    const lines = await captureLog(async () => {
      await harness.speak('The harbour run moves to the half hour from Monday.');
      await harness.end();
    });
    const line = summaryLine(lines, 'm-clean');
    expect(line).toContain('settled turn');
    expect(line).toContain('repeated bullets');
    expect(line).toContain('1/2 ideas in no note');
    // A meeting run with a data dir now leaves a per-tick timing record —
    // the notes pipeline writes one unless an operator turns it off — so the
    // line carries a measured lateness rather than the word unknown. The
    // meeting below, which is given no data dir, is where unknown is asserted.
    expect(line).toContain('0/1 notes late');
  });

  it('says the meeting went badly, and files, when the notes repeat themselves', async () => {
    const board = recordingBoard([{ id: 't-season', status: 'todo' } as Task]);
    const repeat = '- Kestrel Lane keeps the winter crew until April';
    const harness = createNotesTickHarness({
      meetingId: 'm-repeats',
      workspaceId: 'w-1',
      qualityBoard: board,
      compose: (input) => addNotes(input, [repeat, repeat, repeat, repeat, repeat].join('\n')),
    });
    const lines = await captureLog(async () => {
      await harness.speak('Kestrel Lane keeps the winter crew until April.');
      await harness.end();
    });
    const line = summaryLine(lines, 'm-repeats');
    // No data dir, so no timing record was written and none could be read.
    // The line has to say so in a word rather than print a lateness of zero,
    // which is the number a reader would act on.
    expect(line).toContain('lateness unknown');
    expect(line).toContain('BAD');
    expect(line).toContain('repeated bullet');
    expect(board.filed).toEqual(['t-season']);
  });

  it('says a bad meeting was NOT filed when its doc belongs to no row', async () => {
    const board = recordingBoard([]);
    const repeat = '- Kestrel Lane keeps the winter crew until April';
    const harness = createNotesTickHarness({
      meetingId: 'm-orphan',
      workspaceId: 'w-1',
      qualityBoard: board,
      compose: (input) => addNotes(input, [repeat, repeat, repeat, repeat, repeat].join('\n')),
    });
    const lines = await captureLog(async () => {
      await harness.speak('Kestrel Lane keeps the winter crew until April.');
      await harness.end();
    });
    const line = summaryLine(lines, 'm-orphan');
    expect(line).toContain('NOT filed (no-row)');
    expect(board.filed).toEqual([]);
  });

  it('reads only its own section when a second meeting has written below it', async () => {
    // Two meetings on one doc: the second must not be charged with the
    // first's repeats, which is the whole reason the section is addressed by
    // the heading's block id.
    const repeat = '- Kestrel Lane keeps the winter crew until April';
    // ONE heading memory, because one server ran both meetings: it is what
    // tells the second that the section below is the first's record rather
    // than the doc's own standing section.
    const heading = createNotesHeadingMemory();
    const first = createNotesTickHarness({
      heading,
      meetingId: 'm-first',
      compose: (input) => addNotes(input, [repeat, repeat, repeat, repeat, repeat].join('\n')),
    });
    await first.speak('Kestrel Lane keeps the winter crew until April.');
    await first.end();

    const second = createNotesTickHarness({
      heading,
      meetingId: 'm-second',
      ydoc: first.ydoc,
      compose: (input) => addNotes(input, '- New boards go up at the slipway'),
    });
    const lines = await captureLog(async () => {
      await second.speak('New signage boards go up at the slipway.');
      await second.end();
    });
    const line = summaryLine(lines, 'm-second');
    expect(line).toContain('0 repeated bullets');
    expect(line).not.toContain('BAD');
  });
});
