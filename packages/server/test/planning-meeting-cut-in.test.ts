/**
 * The planning voice never talks over the meeting. A spoken-reply session
 * hears a planning meeting through `MeetingEars` on a fake clock:
 *
 *  - a sentence broken off on a dash, then a breath under the 3s an
 *    unfinished phrase waits, is not a pause;
 *  - words heard after the pause but before the question is said withdraw
 *    the question, and the turn goes on with those words;
 *  - words heard while the question plays stop the voice, and the page is
 *    told to stop playing;
 *  - the voice's own words, heard back through the room's microphone, are
 *    not somebody speaking.
 *
 * The model is a script the test answers when it chooses; the voice records
 * what it was given. Fixture names are the house ones.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { cutsIn, echoOf } from '../src/spoken-reply/cut-in.ts';
import { READER_SYSTEM } from '../src/spoken-reply/interview-reader.ts';
import { MeetingEars } from '../src/spoken-reply/meeting-ears.ts';
import { type GateTimers, UNFINISHED_PAUSE_MS } from '../src/spoken-reply/pause-gate.ts';
import { SpokenSession } from '../src/spoken-reply/session.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../src/transcribe.ts';
import { parseVoiceContext } from '../src/voice.ts';
import { DOC_ID, type Fixture, planFixture } from './interview-fixture.ts';
import { waitFor } from './wait-for.ts';

const BERTH_PLAN = `# Harborlight berth plan

## Goal

Open the second Harborlight berth to Riverbend ferries by spring.

### Work

- Dredge the Saltmarsh channel to four metres before March.
- Move the ticket office to the new pier.
`;

const QUESTION = 'Who signs off the dredging?';
const ASK = JSON.stringify({ ask: QUESTION, heading: 'Work' });

function fakeClock() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: GateTimers = {
    set: (fn, ms) => {
      const id = ++next;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (h) => void due.delete(h as number),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const first = [...due.entries()]
        .filter(([, d]) => d.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      due.delete(first[0]);
      now = first[1].at;
      first[1].fn();
    }
    now = until;
  };
  return { timers, advance };
}

const UNUSED: TranscriptionEngine = {
  name: 'unused',
  open: () => Promise.reject(new Error('not this one')),
};

let fx: Fixture | null = null;
afterEach(() => {
  fx?.stop();
  fx = null;
});

/** A reading the test answers by hand: each call waits for `answer`. */
function heldModel() {
  const reads: string[] = [];
  const waiting: Array<(reply: string) => void> = [];
  return {
    reads,
    waiting,
    complete: ({ system, user }: { system: string; user: string }) => {
      if (!system.startsWith(READER_SYSTEM)) return Promise.resolve('');
      reads.push(user);
      return new Promise<string>((resolve) => waiting.push(resolve));
    },
    /** Answer the oldest reading still waiting. */
    answer: (reply: string) => waiting.shift()?.(reply),
  };
}

async function plannedMeeting(voice: SpokenVoice) {
  const model = heldModel();
  const ears = new MeetingEars();
  fx = await planFixture({ markdown: BERTH_PLAN, ears, complete: model.complete });
  ears.started(DOC_ID);
  const clock = fakeClock();
  const json: SpokenServerMessage[] = [];
  const session = new SpokenSession({
    engines: { listener: UNUSED, voices: { 1: voice, 2: null }, gemini: null },
    answerer: fx.answerer,
    timings: new SpokenTimings(undefined, () => {}),
    provenActor: null,
    readOnly: false,
    parseContext: parseVoiceContext,
    sendJson: (m) => json.push(m),
    sendAudio: () => {},
    timers: clock.timers,
    meetingEars: (docId) => ({ engine: ears.engine(docId), plan: true, note: () => {} }),
  });
  session.onText(
    JSON.stringify({
      type: 'start',
      setup: 1,
      mode: 'tap',
      ears: 'meeting',
      context: { surface: 'doc', docId: DOC_ID },
    }),
  );
  let turn = 0;
  const hear = (text: string, final: boolean) =>
    ears.heard(DOC_ID, { turn: final ? turn++ : turn, text, final });
  await waitFor(
    () => {
      hear('The', false);
      return json.some((m) => m.type === 'heard');
    },
    { describe: 'hearing the meeting' },
  );
  const spoken = () => json.filter((m) => m.type === 'reply' && m.spoken);
  const doc = () => fx?.docStore.readOutline(DOC_ID)?.blocks.map((b) => b.text) ?? [];
  return { model, clock, json, session, hear, spoken, doc };
}

const MUTE: SpokenVoice = { name: 'mute', async speak() {} };

describe('cutsIn', () => {
  it('is words that are not the voice heard back', () => {
    expect(cutsIn('Actually the Saltmarsh office', QUESTION)).toBe(true);
    expect(cutsIn('Who signs off the', QUESTION)).toBe(false);
    expect(echoOf('who signs off', QUESTION)).toBe(true);
    // Punctuation alone is no one speaking; with nothing said, any word is.
    expect(cutsIn('…', '')).toBe(false);
    expect(cutsIn('So', '')).toBe(true);
  });

  it('does not count the Soniox tags leading a line as words the voice says', () => {
    const line = '[calm] [warm] Riverbend is ahead.';
    expect(cutsIn('Calm, warm.', line)).toBe(true);
    expect(echoOf('Riverbend is ahead', line)).toBe(true);
  });
});

describe('the planning voice never talks over the meeting', () => {
  it('a sentence broken off on a dash, then a breath under 3s, is no pause', async () => {
    const m = await plannedMeeting(MUTE);
    m.hear('The berth opens in spring and I noticed that there’s—', true);
    m.clock.advance(UNFINISHED_PAUSE_MS - 1);
    expect(m.model.reads).toEqual([]);
    // The breath ends inside the window: the same thought goes on.
    m.hear('the ticket office', false);
    m.hear('the ticket office moves first.', true);
    expect(m.model.reads).toHaveLength(1);
    expect(m.model.reads[0]).toContain('there’s— the ticket office moves first.');
    m.session.close();
  });

  it('words heard before the question is said withdraw it, and the turn goes on with them', async () => {
    const m = await plannedMeeting(MUTE);
    m.hear('The berth opens in spring.', true);
    await waitFor(() => m.model.reads.length === 1, { describe: 'the reading' });
    // He goes on while the plan is read.
    m.hear('I noticed that there’s', false);
    expect(m.json.filter((x) => x.type === 'cut-in')).toHaveLength(1);
    m.model.answer(ASK);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.spoken()).toEqual([]);

    // The turn he went on with ends at its own pause, with all of it heard.
    m.hear('I noticed that there’s a second crane on the pier.', true);
    await waitFor(() => m.model.reads.length === 2, { describe: 'a fresh reading' });
    expect(m.model.reads[1]).toContain('I noticed that there’s a second crane on the pier.');
    expect(m.model.reads[1]).toContain('ALREADY ASKED:\n(none)');
    m.model.answer(ASK);
    await waitFor(() => m.spoken().length === 1, { describe: 'the question, at a real pause' });
    expect(m.spoken()[0]).toMatchObject({ spoken: QUESTION, asking: true });
    // Nothing he said over the withdrawn question was written as its answer.
    expect(m.doc().some((t) => t.includes('crane'))).toBe(false);
    m.session.close();
  });

  it('words heard while the question plays stop the voice, and the page stops playing', async () => {
    let signal: AbortSignal | undefined;
    const slow: SpokenVoice = {
      name: 'slow',
      speak: (_text, onAudio, s) => {
        signal = s;
        onAudio(new Uint8Array(480));
        return new Promise<void>((resolve) => s?.addEventListener('abort', () => resolve()));
      },
    };
    const m = await plannedMeeting(slow);
    m.hear('The berth opens in spring.', true);
    await waitFor(() => m.model.reads.length === 1, { describe: 'the reading' });
    m.model.answer(ASK);
    await waitFor(() => m.json.some((x) => x.type === 'audio-start'), { describe: 'the voice' });
    // The room hears the voice itself: that is not somebody speaking.
    m.hear('Who signs off the', false);
    expect(signal?.aborted).toBe(false);
    m.hear('Actually the Saltmarsh office', false);
    expect(signal?.aborted).toBe(true);
    expect(m.json.filter((x) => x.type === 'cut-in')).toHaveLength(1);
    // What he said over it is the start of a new turn, not its answer.
    m.hear('Actually the Saltmarsh office has the crane.', true);
    await waitFor(() => m.model.reads.length === 2, { describe: 'a fresh reading' });
    expect(m.doc().some((t) => t.includes('crane'))).toBe(false);
    m.session.close();
  });
});
