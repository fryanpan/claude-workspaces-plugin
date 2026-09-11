/**
 * The timing log is the instrument this whole change is measured with, so it
 * gets its own tests: an instrument nobody has checked cannot settle an
 * argument about latency.
 *
 * Two things it must never do — repeat a word anybody said, and cost a
 * meeting a note when the disk refuses it — are asserted here rather than
 * being left to the reader of the module.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withServerNotesSinks } from '../src/meeting-notes-doc.ts';
import { createStubNotesComposer } from '../src/meeting-notes.ts';
import {
  type NotesTickTiming,
  createNotesTimingLog,
  hypothesisFor,
  median,
} from '../src/notes-timing.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

const row = (over: Partial<NotesTickTiming> = {}): NotesTickTiming => ({
  tick: 1,
  reason: 'pause',
  turns: [0],
  settledAt: 1000,
  spokenAt: null,
  lastSpokenAt: null,
  startedAt: 1200,
  waitedMs: 0,
  promptChars: null,
  replyChars: null,
  firstTokenMs: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  calls: [],
  composeMs: 800,
  model: null,
  applyMs: 5,
  edits: 1,
  blocks: 1,
  merged: 1,
  outcome: 'written',
  settledToWrittenMs: 2000,
  spokenToWrittenMs: null,
  lastSpokenToWrittenMs: null,
  ...over,
});

describe('the per-tick timing log', () => {
  it('reports the median and the worst of the latencies it saw', () => {
    const log = createNotesTimingLog();
    for (const ms of [4000, 1000, 9000, 2000, 3000]) {
      log.record(row({ settledToWrittenMs: ms }));
    }
    expect(log.summary()).toBe(
      '[notes-timing] 5 tick(s): settled-to-written median 3000ms, worst 9000ms',
    );
  });

  it('says nothing about a meeting where no note ever landed', () => {
    // The dangerous shape: a summary that prints 0ms for a meeting that
    // produced nothing reads as the best meeting ever recorded.
    const log = createNotesTimingLog();
    log.record(row({ outcome: 'failed', settledToWrittenMs: null }));
    expect(log.summary()).toBeNull();
  });

  it('counts the writes that were skipped in the summary line', () => {
    const log = createNotesTimingLog();
    log.record(row({ settledToWrittenMs: 1000 }));
    log.record(row({ outcome: 'failed', settledToWrittenMs: null }));
    expect(log.summary()).toContain('1 write(s) skipped');
  });

  it('names the hypothesis each line settles', () => {
    // A refused write outranks every other shape: it is the one that loses
    // words, whatever clock produced the tick.
    expect(hypothesisFor(row({ outcome: 'failed', reason: 'cadence' }))).toContain('H4');
    expect(hypothesisFor(row({ merged: 3 }))).toContain('H3');
    expect(hypothesisFor(row({ reason: 'cadence' }))).toContain('H1');
    expect(hypothesisFor(row({ reason: 'pause' }))).toContain('H2');
    expect(hypothesisFor(row({ reason: 'end', waitedMs: 700 }))).toContain('H5');
  });

  it('writes one JSON line per tick, holding numbers and no words', () => {
    const dir = mkdtempSync(join(tmpdir(), 'notes-timing-'));
    try {
      const path = join(dir, 'nested', 'm-1-timing.jsonl');
      const log = createNotesTimingLog({ path });
      log.record(row({ tick: 1, settledToWrittenMs: 1500, model: 'haiku', promptChars: 4000 }));
      log.record(row({ tick: 2, settledToWrittenMs: 2500 }));
      expect(log.summary()).toContain('worst 2500ms');

      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(3); // two ticks and the summary
      const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      expect(first.tick).toBe(1);
      expect(first.turns).toEqual([0]);
      expect(first.promptChars).toBe(4000);
      expect(first.hypothesis).toBe('H2 endpoint became a pause');
      // Every value is a number, a boolean, or one of the small vocabulary
      // of labels this module defines. Nothing anybody said can be in here.
      const vocabulary = ['pause', 'cadence', 'end', 'written', 'failed', 'empty', 'haiku'];
      for (const [key, value] of Object.entries(first)) {
        if (typeof value !== 'string') continue;
        expect([key, value, vocabulary.includes(value) || key === 'hypothesis']).toEqual([
          key,
          value,
          true,
        ]);
      }
      const summary = JSON.parse(lines[2] ?? '{}') as Record<string, unknown>;
      expect(summary).toMatchObject({ summary: true, ticks: 2, medianMs: 2500, worstMs: 2500 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps recording when the file cannot be written', () => {
    // A meeting must not lose a note because its instrumentation could not
    // write. The path is a directory that will not be created under a file.
    const dir = mkdtempSync(join(tmpdir(), 'notes-timing-bad-'));
    try {
      const errors: string[] = [];
      const log = createNotesTimingLog({ path: join(dir), onError: (m) => errors.push(m) });
      log.record(row({ settledToWrittenMs: 1200 }));
      expect(errors.length).toBeGreaterThan(0);
      // The in-memory rows are unaffected, so the summary still answers.
      expect(log.rows()).toHaveLength(1);
      expect(log.summary()).toContain('median 1200ms');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes the upper middle of an even count, and nothing from none', () => {
    expect(median([])).toBeNull();
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(median([5])).toBe(5);
  });
});

describe('the clock the person is actually on', () => {
  /**
   * Everything else in this file measures from `settledAt` — the moment the
   * transcript stopped changing. That is not the moment anybody stopped
   * talking: endpointing and transcription sit in between, and the whole
   * point of the second clock is that the leg it hides was never instrumented
   * at all. These two tests are what says the row carries the SPOKEN instant
   * and derives its wait from it, rather than relabelling the settled one.
   */
  it('records when the words were spoken, and measures the wait from there', async () => {
    const spokenAt = Date.now() - 30_000;
    const h = createNotesTickHarness({ compose: (input) => addNotes(input, '- a point') });
    h.say({ text: 'we should ship the six second ceiling', spokenAt });
    await h.tick();

    const [written] = h.timing().rows();
    expect(written?.spokenAt).toBe(spokenAt);
    // The last frame of the turn is a millisecond later — the harness's stand
    // -in for a turn whose words keep arriving.
    expect(written?.lastSpokenAt).toBe(spokenAt + 1);
    // The algebra, not the wall clock: both waits end at the same write, so
    // the difference between them IS the leg the settled clock cannot see.
    // A row that had quietly derived its spoken wait from `settledAt` would
    // fail this by exactly the 30 seconds the words spent in the engine.
    const settledAt = written?.settledAt ?? 0;
    expect((written?.spokenToWrittenMs ?? 0) - (written?.settledToWrittenMs ?? 0)).toBe(
      settledAt - spokenAt,
    );
    expect((written?.lastSpokenToWrittenMs ?? 0) - (written?.settledToWrittenMs ?? 0)).toBe(
      settledAt - (spokenAt + 1),
    );
  });

  it('reports nothing rather than a guess when the engine gives it no offsets', async () => {
    // The control, and the case most meetings are in: no spoken clock is
    // available, and the row must say so. A zero here would read as "the note
    // was instant" on every report in the repo.
    const h = createNotesTickHarness({ compose: (input) => addNotes(input, '- a point') });
    await h.speak('we should ship the six second ceiling');

    const [written] = h.timing().rows();
    expect(written?.spokenAt).toBeNull();
    expect(written?.lastSpokenAt).toBeNull();
    expect(written?.spokenToWrittenMs).toBeNull();
    expect(written?.lastSpokenToWrittenMs).toBeNull();
    // And the settled clock still works, so the null is about the new clock
    // rather than about a broken row.
    expect(written?.settledToWrittenMs).not.toBeNull();
  });
});

describe('when the server writes a timing file at all', () => {
  // `delete` is a lint error and `= undefined` is not the same thing: it
  // leaves the STRING "undefined" in the environment, which is a value the
  // gate would read. `Reflect.deleteProperty` actually unsets it.
  const unset = (): void => {
    Reflect.deleteProperty(process.env, 'CW_NOTES_TIMING');
  };
  const was = process.env.CW_NOTES_TIMING;
  afterEach(() => {
    if (was === undefined) unset();
    else process.env.CW_NOTES_TIMING = was;
  });

  /** The deps a meeting session would run on, for one data dir. */
  const sinksFor = (dataDir: string | undefined) =>
    withServerNotesSinks(
      { composer: createStubNotesComposer(), onNotes: () => {} },
      {
        docStore: () => ({}) as never,
        tasks: () => ({ listTasks: () => [] }),
        ...(dataDir !== undefined ? { dataDir } : {}),
      },
    );

  it('opens one for every meeting, with no flag set', () => {
    // It used to be opt-in, which made it unreadable by anything downstream:
    // a file that is there only when somebody remembered a flag cannot be
    // the input to an at-stop report.
    unset();
    const dir = mkdtempSync(join(tmpdir(), 'notes-timing-default-'));
    try {
      const open = sinksFor(dir).openTiming;
      expect(open).toBeDefined();
      open?.({ docId: 'd-1', meetingId: 'm-1' })?.record(row());
      expect(existsSync(join(dir, 'meetings', 'd-1', 'm-1-timing.jsonl'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens none when the operator turned it off', () => {
    process.env.CW_NOTES_TIMING = '0';
    const dir = mkdtempSync(join(tmpdir(), 'notes-timing-off-'));
    try {
      expect(sinksFor(dir).openTiming).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens none when there is no data dir to write it in', () => {
    // A server built without a data dir has nowhere to put it, and '.' is
    // not an answer — that is somebody's working tree.
    unset();
    expect(sinksFor(undefined).openTiming).toBeUndefined();
  });
});
