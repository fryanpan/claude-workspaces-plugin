/**
 * ONE MODEL CALL PER TICK, on the path a live meeting runs.
 *
 * A tick used to make two calls: a task-capture pass, and then the compose
 * that writes the note. The capture pass ran in front of every compose and
 * its median was 1.6s, its worst 9.3s — time the note waited for, on a
 * feature the notes themselves do not need. Bryan's call (2026-09-18) was to
 * take it off the live path, so `server-deps.ts` builds no extractor and
 * `bin.ts` passes none.
 *
 * What is NOT removed: `meeting-task-capture.ts`, the `taskExtractor` seam on
 * `withServerNotesSinks`, and the harness option below. A caller that asks
 * for the capture pass still gets it — `bun run meeting:rerun --capture`
 * replays the old two-call pipeline — so the control arm here is the same
 * wiring the server used to build, which is what makes the one-call arm
 * evidence rather than a measurement that sees nothing.
 *
 * All speech here is invented. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import {
  type TaskCaptureBoard,
  createHaikuTaskCaptureExtractor,
} from '../src/meeting-task-capture.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';

/** What the fake capture API reports it charged. A reply with no usage block
 *  records no call at all, so an arm meant to SEE the second call has to
 *  carry one. */
const CAPTURE_USAGE = {
  input_tokens: 2_000,
  output_tokens: 40,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** A board the capture pass can look at and file nothing against. */
const emptyBoard: TaskCaptureBoard = {
  listTasks: () => [],
  createTask: () => ({ ok: false as const, error: 'not used here' }),
  transition: () => ({ ok: true as const }),
};

/** The real extractor over a fake HTTP seam: no key, no network, one billed
 *  call per tick, which is exactly what the arm is there to show. */
function fakeCapture(calls: { n: number }) {
  const extractor = createHaikuTaskCaptureExtractor({
    apiKey: 'test-key-not-a-real-one',
    fetchImpl: (async (_url: unknown, _init?: RequestInit) => {
      calls.n++;
      return new Response(JSON.stringify({ content: [{ text: '[]' }], usage: CAPTURE_USAGE }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
  if (!extractor) throw new Error('extractor did not build');
  return extractor;
}

/** The composer's own seam for saying what the API charged — the real Haiku
 *  composer calls it, and a tick's `calls` list is built from it. Without it
 *  a scripted meeting records no calls at all and both arms below would read
 *  zero for opposite reasons. */
function composeReporting(input: import('../src/meeting-notes.ts').NotesComposeInput, n: number) {
  input.measure?.({ model: 'claude-haiku-4-5-20251001' });
  input.measure?.({
    usage: { inputTokens: 10_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  return addNotes(input, `- point ${n}`);
}

const SAID = [
  'Harborlight wants the survey moved to the back half of the week.',
  'Riverbend can take the write-up if the data lands on Tuesday.',
  'Alice will say on Thursday whether the second room is booked.',
];

describe('what a tick spends a model call on', () => {
  it('the live wiring composes and does nothing else', async () => {
    // The deps the server builds today: a composer, and no task extractor.
    const h = createNotesTickHarness({ compose: composeReporting });
    for (const line of SAID) await h.speak(line);
    await h.end();

    const rows = h.timing().rows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.calls.map((c) => c.call)).toEqual(['compose']);
      // The clock for the pass that is gone: null, not zero — nothing ran.
      expect(row.captureMs).toBeNull();
    }
  });

  it('a caller that asks for the capture pass still gets it — so the count above is real', async () => {
    const calls = { n: 0 };
    const h = createNotesTickHarness({
      workspaceId: 'w-test',
      captureBoard: emptyBoard,
      taskExtractor: fakeCapture(calls),
      compose: composeReporting,
    });
    for (const line of SAID) await h.speak(line);
    await h.end();

    const rows = h.timing().rows();
    const withCapture = rows.filter((r) => r.calls.some((c) => c.call === 'capture'));
    // The arm above is not measuring a hole: wire the extractor back and the
    // same reading shows a second call on the same ticks.
    expect(withCapture.length).toBeGreaterThan(0);
    expect(calls.n).toBeGreaterThan(0);
  });
});
