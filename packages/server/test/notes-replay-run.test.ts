/**
 * A recorded meeting, replayed through the live notes wiring with a scripted
 * note-taker — the half of `scripts/notes-replay.ts` that costs nothing.
 * Everything said here is invented. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planMeetings } from '../../../scripts/notes-replay-lib.ts';
import type { NotesComposer } from '../src/meeting-notes.ts';
import { meetingIndexPath, meetingTimingPath, meetingTranscriptPath } from '../src/meetings.ts';
import type { NotesCoverageJudge } from '../src/notes-coverage-judge.ts';
import { notesTopicHashes } from '../src/notes-heading-level.ts';
import { notesQualityFiledPath } from '../src/notes-quality-filed-store.ts';
import { readTickWaits } from '../src/notes-tick-timing.ts';
import { runReplay } from './notes-replay-run.ts';
import { addNotes } from './notes-tick-harness.ts';

const T0 = 1_800_000_000_000;
const DOC = 'd-pier';
const MEETING = 'm-pier-1';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Two legs of one meeting, a reconnect between them, a name given in each. */
function meeting() {
  const index = [
    { meetingId: MEETING, docId: DOC, startedAt: T0 },
    { meetingId: MEETING, speakers: { 'remote:A': 'Alice' } },
    { meetingId: MEETING, endedAt: T0 + 40_000, turns: 2 },
    { meetingId: MEETING, resumedAt: T0 + 45_000 },
    { meetingId: MEETING, speakers: { 'remote:B': 'Bob' } },
    { meetingId: MEETING, endedAt: T0 + 90_000, turns: 4 },
  ];
  const rows = [
    { turn: 0, text: 'The Harborlight pier reopens in June.', ts: T0 + 5_000, speaker: 'remote:A' },
    { turn: 1, text: 'Riverbend wants the budget first.', ts: T0 + 20_000, speaker: 'remote:B' },
    { turn: 2, text: 'Saltmarsh signs off on Friday.', ts: T0 + 55_000, speaker: 'remote:A' },
    { turn: 3, text: 'Bob drafts the letter.', ts: T0 + 70_000, speaker: 'remote:B' },
  ];
  return planMeetings(index, new Map([[MEETING, rows]]));
}

describe('runReplay', () => {
  it('writes each settled turn into the notes, leg by leg, and records the timeline', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'notes-replay-'));
    dirs.push(dataDir);
    const sessions: number[] = [];
    let wall = 0;
    const composer: NotesComposer = {
      name: 'scripted',
      async compose(input) {
        // Every compose takes two seconds of the model's time.
        wall += 2_000;
        sessions.push(input.tick.tick);
        return addNotes(input, input.tick.turns.map((t) => `- ${t.text}`).join('\n'), 'Pier');
      },
    };
    const result = await runReplay({
      docId: DOC,
      docTitle: 'Harborlight sync',
      meetings: meeting(),
      dataDir,
      composer,
      wall: () => wall,
    });

    // A long turn may reach the notes in pieces (the settled prefix composes
    // mid-turn), so each turn is looked for by one word of its own.
    for (const word of ['June', 'budget', 'Friday', 'letter']) {
      expect(result.markdown).toContain(word);
    }
    expect(result.errors).toEqual([]);
    expect(result.summaries).toHaveLength(2);
    // Tick numbering restarts with the second leg, as a reconnect does.
    expect(sessions.filter((n) => n === 1)).toHaveLength(2);

    // The record the relay would have left: index lines and settled turns.
    const index = readFileSync(meetingIndexPath(dataDir, DOC), 'utf8').trim().split('\n');
    expect(index).toHaveLength(6);
    const transcript = readFileSync(meetingTranscriptPath(dataDir, DOC, MEETING), 'utf8');
    expect(transcript.trim().split('\n')).toHaveLength(4);

    // Waits are on the recording's own clock and include the compose time.
    const waits = readTickWaits(dataDir, DOC, MEETING)?.map((w) => w.waitMs) ?? [];
    expect(waits.length).toBeGreaterThan(0);
    expect(Math.min(...waits)).toBeGreaterThanOrEqual(2_000);
    expect(Math.max(...waits)).toBeLessThan(60_000);
    expect(result.turnWaits.every((w) => w.writtenAt !== null)).toBe(true);
    expect(existsSync(meetingTimingPath(dataDir, DOC, MEETING))).toBe(true);
  });

  it('charges the model reply time to the note that waited on it', async () => {
    const firstWait = async (composeMs: number): Promise<number | undefined> => {
      const dataDir = mkdtempSync(join(tmpdir(), 'notes-replay-'));
      dirs.push(dataDir);
      let wall = 0;
      await runReplay({
        docId: DOC,
        meetings: meeting(),
        dataDir,
        wall: () => wall,
        composer: {
          name: 'scripted',
          async compose(input) {
            wall += composeMs;
            return addNotes(input, input.tick.turns.map((t) => `- ${t.text}`).join('\n'));
          },
        },
      });
      return readTickWaits(dataDir, DOC, MEETING)?.[0]?.waitMs;
    };
    const instant = await firstWait(0);
    const slow = await firstWait(3_000);
    expect(instant).toBeDefined();
    expect((slow ?? 0) - (instant ?? 0)).toBe(3_000);
  });

  it('files a quality item when the notes cross a bar, as the live server does', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'notes-replay-'));
    dirs.push(dataDir);
    const result = await runReplay({
      docId: DOC,
      meetings: meeting(),
      dataDir,
      composer: {
        // A new topic every tick, each a wall of six flat bullets: past the
        // flat-run bar on every topic, which the pass reports.
        name: 'writes walls',
        compose: async (input) => [
          {
            op: 'insert_at_end',
            markdown: `${notesTopicHashes(input.outline)} Pier part ${input.tick.tick}\n\n${Array.from(
              { length: 6 },
              (_, i) => `- Pier point ${input.tick.tick}.${i}`,
            ).join('\n')}`,
          },
        ],
      },
    });
    expect(result.filings.map((f) => f.op)).toContain('file');
  });

  it('reads what the notes left out once per meeting, after its last leg, and files it', async () => {
    const run = async (judge?: NotesCoverageJudge) => {
      const dataDir = mkdtempSync(join(tmpdir(), 'notes-replay-'));
      dirs.push(dataDir);
      const result = await runReplay({
        docId: DOC,
        meetings: meeting(),
        dataDir,
        // One tidy note per tick: past no lexical bar.
        composer: {
          name: 'one note',
          compose: async (input) => addNotes(input, `- ${input.tick.turns[0]?.text ?? 'A point'}`),
        },
        ...(judge ? { coverageJudge: judge } : {}),
      });
      const filed = notesQualityFiledPath(dataDir, DOC, MEETING);
      const kinds = existsSync(filed)
        ? (JSON.parse(readFileSync(filed, 'utf8')) as { verdict?: { kinds?: string[] } }).verdict
            ?.kinds
        : undefined;
      return { result, kinds };
    };
    let calls = 0;
    const lossy: NotesCoverageJudge = async () => {
      calls++;
      return { ideas: 20, lost: 5, windows: 1, judgedWindows: 1 };
    };
    const judged = await run(lossy);
    expect(calls).toBe(1);
    expect(judged.result.filings.map((f) => f.op)).toContain('file');
    expect(judged.kinds).toContain('coverage');
    const unjudged = await run();
    expect(unjudged.result.filings).toEqual([]);
  });

  it('restores the real clock afterwards', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'notes-replay-'));
    dirs.push(dataDir);
    const realNow = Date.now;
    await runReplay({
      docId: DOC,
      meetings: meeting(),
      dataDir,
      composer: { name: 'none', compose: async () => [] },
    });
    expect(Date.now).toBe(realNow);
  });
});
