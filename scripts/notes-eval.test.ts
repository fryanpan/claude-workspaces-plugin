import { describe, expect, it, test } from 'vitest';
/**
 * The eval's invented-link column, over a synthetic meeting.
 *
 * The real eval spends money and talks to a model, so what is checked here is
 * the COUNTING: a scripted composer that invents an address must show up in
 * the column, and one that cites what it was handed must not. Driven through
 * the same tick harness the eval drives, so the shape the column reads —
 * `shot.input` and `shot.composed` — is the shape the run really produces.
 *
 * Fictional throughout: Riverbend's board, example.com.
 */
import { emptyHeadings } from '../packages/server/src/notes-quality.ts';
import { addNotes, createNotesTickHarness } from '../packages/server/test/notes-tick-harness.ts';
import {
  Behaviour,
  JudgeBudget,
  JudgeWindow,
  type JudgedWindow,
  MAX_JUDGED_WINDOW_TICKS,
  inventedLinkVerdict,
} from './notes-eval.ts';

const ROW = '/workspaces/w-riverbend?task=t-42';
const INVENTED = 'https://web.archive.org/web/2019/https://example.com/gate';

/** A one-tick meeting whose composer answers with `markdown`. */
async function runTick(
  markdown: string,
  notesBefore = '',
): Promise<ReturnType<typeof inventedLinkVerdict>> {
  const harness = createNotesTickHarness({
    doc: `## Meeting notes\n\n${notesBefore}`,
    workspaceId: 'w-riverbend',
    tasks: [{ id: 't-42', title: 'Riverbend gate moves before merge', status: 'todo' }],
    compose: (input) => [
      input.notesHeadingId === undefined
        ? { op: 'insert_at_end', markdown: `## Meeting notes\n\n${markdown}` }
        : { op: 'insert_under_heading', headingId: input.notesHeadingId, markdown },
    ],
  });
  const shot = await harness.speak({
    speaker: 'A',
    text: 'the Riverbend gate moves before merge, Devi to confirm',
  });
  return inventedLinkVerdict(shot, notesBefore);
}

describe('the invented-link column', () => {
  test('a composed link the tick was never given fails the column', async () => {
    const verdict = await runTick(`- Devi cited [the archive](${INVENTED}) on the gate.`);
    expect(verdict?.ok).toBe(false);
    expect(verdict?.detail).toContain('web.archive.org');
  });

  test('CONTROL: the row this tick actually named passes', async () => {
    const verdict = await runTick(`- [Riverbend gate moves before merge](${ROW}) — Devi confirms.`);
    expect(verdict).not.toBeNull();
    expect(verdict?.ok).toBe(true);
  });

  test('a tick that composed no link at all is not an example', async () => {
    expect(await runTick('- The gate moves before merge, Devi to confirm.')).toBeNull();
  });

  test('a citation the notes already carried is not counted against this tick', async () => {
    const verdict = await runTick(
      '- Still [the spec](https://example.com/riverbend/spec), unchanged.',
      '- Read [the spec](https://example.com/riverbend/spec).\n',
    );
    expect(verdict?.ok).toBe(true);
  });

  test('a tick whose compose never ran is not an example', () => {
    expect(inventedLinkVerdict({ composed: [] }, '')).toBeNull();
  });
});

describe('one bad bullet is one miss, however many ticks it survives', () => {
  // The number the shipping table is read against. A decidable check reads
  // the notes at every tick, so a bullet written on tick one fails every
  // tick after it; without this the rate reads a single unlucky line as a
  // systematic gap between two methods.
  function seen(details: Array<[where: string, detail: string]>): Behaviour {
    const b = new Behaviour('1.4', 'test');
    for (const [where, detail] of details) b.see({ ok: false, detail }, where);
    return b;
  }

  it('counts the surviving bullet once', () => {
    const b = seen([
      ['ES2003b tick 1', 'people will buy it'],
      ['ES2003b tick 2', 'people will buy it'],
      ['ES2003b tick 3', 'people will buy it'],
    ]);
    expect(b.failures).toHaveLength(3);
    expect(b.distinctFailures).toBe(1);
  });

  it('the same wording in another meeting is another miss', () => {
    const b = seen([
      ['ES2003b tick 1', 'people will buy it'],
      ['ES2002d tick 9', 'people will buy it'],
    ]);
    expect(b.distinctFailures).toBe(2);
  });

  it('MUTATION CONTROL: different bullets in one meeting stay separate', () => {
    // If this collapsed too, the count would be measuring the meeting name
    // rather than what actually failed.
    const b = seen([
      ['ES2003b tick 1', 'people will buy it'],
      ['ES2003b tick 1', 'the chip cost is unclear'],
    ]);
    expect(b.distinctFailures).toBe(2);
  });
});

/**
 * Which ticks the judge is shown, once the note-taker's two-frame heading
 * rule is taken into account.
 *
 * Driven through the same tick harness the eval drives, with a composer
 * scripted to obey the shipped instruction — "open a new '### ' heading …
 * then add its bullets under its own id on the next update" — so what the
 * judge would be handed is what a real run really produces, not a string a
 * test wrote. The judge itself is never called: what is asserted is the
 * NOTES it is asked about, which is the whole of what the artefact was.
 *
 * Fictional throughout: a remote-control design meeting that never happened.
 */

const BATTERY = 'Battery life';
const CASING = 'Casing colour';
/** A heading the meeting opens with, so a tick can write somewhere that is
 *  NOT the heading under test. Bullets appended to the notes section land
 *  under whatever heading is last, which is how a script meaning "write
 *  elsewhere" quietly fills the very heading it is supposed to strand. */
const BEEP = 'Locator beep';
const OPENING = `### ${BEEP}\n\n- the remote has to survive the couch\n`;

/** One thing a tick's compose does. A tick does any number of them. */
type Frame = { heading: string } | { under: string; markdown: string };

/**
 * Run a scripted meeting and collect the windows the judge would be asked
 * about, in order. `wanted` names the 0-based ticks the sampler drew.
 */
async function windowsFor(
  script: ReadonlyArray<readonly Frame[]>,
  wanted: readonly number[],
): Promise<JudgedWindow[]> {
  const harness = createNotesTickHarness({
    doc: `## Meeting notes\n\n${OPENING}`,
    compose: (input, tick) =>
      (script[tick - 1] ?? []).flatMap((frame) => {
        if ('heading' in frame) return addNotes(input, `### ${frame.heading}`);
        const head = input.outline.find(
          (e) => e.kind === 'heading' && e.text.includes(frame.under),
        );
        return head
          ? [{ op: 'insert_under_heading' as const, headingId: head.id, markdown: frame.markdown }]
          : [];
      }),
  });
  const window = new JudgeWindow();
  const out: JudgedWindow[] = [];
  let before = '';
  for (let i = 0; i < script.length; i++) {
    const shot = await harness.speak({ speaker: 'A', text: `tick ${i + 1} speech` });
    const judged = window.offer({
      wanted: wanted.includes(i),
      before,
      after: shot.notes,
      transcript: `tick ${i + 1} speech`,
      where: `ES2002a tick ${i + 1}`,
    });
    if (judged) out.push(judged);
    before = shot.notes;
  }
  const tail = window.flush();
  if (tail) out.push(tail);
  return out;
}

describe('the two-frame heading artefact', () => {
  test('the judge is asked about the heading and its bullets together', async () => {
    const windows = await windowsFor(
      [
        [{ heading: BATTERY }],
        [{ under: BATTERY, markdown: '- a year on a coin cell, Carla prices kinetic' }],
        [{ under: BEEP, markdown: '- the beep has to be loud' }],
      ],
      [0],
    );
    expect(windows).toHaveLength(1);
    // THE ASSERTION THE ARTEFACT FAILS: judged a tick at a time, the notes
    // the judge is handed are the heading with nothing under it.
    expect(emptyHeadings(windows[0]!.after)).toEqual([]);
    expect(windows[0]!.after).toContain('coin cell');
    // And the speech it is judged against is both ticks', not one of them.
    expect(windows[0]!.transcript).toContain('tick 1 speech');
    expect(windows[0]!.transcript).toContain('tick 2 speech');
    expect(windows[0]!.where).toBe('ES2002a ticks 1-2');
  });

  test('CONTROL: a heading still empty a tick later is still put to the judge', async () => {
    const windows = await windowsFor(
      [[{ heading: BATTERY }], [{ under: BEEP, markdown: '- the beep has to be loud' }]],
      [0],
    );
    expect(windows).toHaveLength(1);
    // The window closed — the second tick opened nothing — and what it closed
    // on still carries the heading nobody filled. A judge that could not see
    // this would have bought its clean number by going blind.
    expect(emptyHeadings(windows[0]!.after)).toEqual([BATTERY]);
  });

  test('CONTROL: a heading the meeting never comes back to reaches the judge at the end', async () => {
    const windows = await windowsFor(
      [[{ under: BEEP, markdown: '- the beep has to be loud' }], [{ heading: BATTERY }]],
      [1],
    );
    expect(windows).toHaveLength(1);
    expect(emptyHeadings(windows[0]!.after)).toEqual([BATTERY]);
    expect(windows[0]!.where).toBe('ES2002a tick 2');
  });

  test('a window opened again by its own second tick runs on until the bullets land', async () => {
    const windows = await windowsFor(
      [
        [{ heading: BATTERY }],
        [{ under: BATTERY, markdown: '- a year on a coin cell' }, { heading: CASING }],
        [{ under: CASING, markdown: '- yellow, swatch goes Friday' }],
      ],
      [0],
    );
    expect(windows).toHaveLength(1);
    expect(emptyHeadings(windows[0]!.after)).toEqual([]);
    expect(windows[0]!.where).toBe('ES2002a ticks 1-3');
  });

  test('a window stops widening at the cap, so a stuck note-taker still reaches the judge', async () => {
    const windows = await windowsFor(
      [
        [{ heading: 'One' }],
        [{ heading: 'Two' }],
        [{ heading: 'Three' }],
        [{ heading: 'Four' }],
        [{ under: 'Four', markdown: '- something at last' }],
      ],
      [0],
    );
    expect(windows[0]!.where).toBe(`ES2002a ticks 1-${MAX_JUDGED_WINDOW_TICKS}`);
    expect(emptyHeadings(windows[0]!.after).length).toBeGreaterThan(0);
  });

  test('a tick the sampler never drew is not judged on its own', async () => {
    const windows = await windowsFor(
      [
        [{ under: BEEP, markdown: '- the beep has to be loud' }],
        [{ under: BEEP, markdown: '- and cheap' }],
      ],
      [1],
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]!.where).toBe('ES2002a tick 2');
  });

  test('an ordinary tick is judged on its own, exactly as before', async () => {
    const windows = await windowsFor(
      [[{ under: BEEP, markdown: '- the beep has to be loud' }]],
      [0],
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]!.where).toBe('ES2002a tick 1');
    expect(windows[0]!.transcript).toBe('tick 1 speech');
  });
});

describe('what a window counts as one distinct failure', () => {
  test('the same complaint across two windows of one meeting is one thing', () => {
    const b = new Behaviour('1.1', 'Covers discussed / decided / next');
    b.see({ ok: false, detail: 'heading left empty' }, 'ES2002a ticks 1-2');
    b.see({ ok: false, detail: 'heading left empty' }, 'ES2002a ticks 7-8');
    b.see({ ok: false, detail: 'heading left empty' }, 'ES2002a tick 12');
    expect(b.examples).toBe(3);
    expect(b.distinctFailures).toBe(1);
  });
});

describe('what a judge slot buys', () => {
  /**
   * Walk a meeting, judging whenever the budget says so and letting each call
   * read `span` ticks, and report which tick each call ENDED on.
   */
  function callsOver(ticks: number, calls: number, span: number): number[] {
    const budget = new JudgeBudget(calls, ticks);
    const ended: number[] = [];
    for (let i = 0; i < ticks; i++) {
      if (!budget.due(i)) continue;
      const last = Math.min(ticks - 1, i + span - 1);
      ended.push(last);
      budget.spent(last);
      i = last;
    }
    return ended;
  }

  test('a window spanning the next slot does not spend it as well', () => {
    // Six calls asked for over twelve ticks, every call reading three of
    // them: four is the ceiling the meeting itself sets. A fixed list of
    // slots at 0, 2, 4, 6, 8, 10 buys THREE, because each window covers the
    // slot behind it and that slot is spent unjudged.
    expect(callsOver(12, 6, 3)).toEqual([2, 5, 8, 11]);
  });

  test('CONTROL: single-tick calls are spread across the meeting, not taken from the front', () => {
    // The reason the budget re-lays a schedule rather than just counting to
    // six: the first ticks of a meeting are its easiest.
    const ended = callsOver(12, 6, 1);
    expect(ended).toHaveLength(6);
    expect(ended[0]).toBe(0);
    expect(ended[ended.length - 1]!).toBeGreaterThan(6);
  });

  test('a budget cannot buy more calls than there are ticks', () => {
    expect(callsOver(4, 6, 1)).toHaveLength(4);
  });

  test('nothing is due once the calls are spent', () => {
    const budget = new JudgeBudget(1, 10);
    expect(budget.due(0)).toBe(true);
    budget.spent(0);
    for (let i = 1; i < 10; i++) expect(budget.due(i)).toBe(false);
  });
});

describe('the count of windows that waited', () => {
  test('a window flushed at the end of the meeting is counted like any other', async () => {
    const window = new JudgeWindow();
    window.offer({
      wanted: true,
      before: '- a bullet\n',
      after: '- a bullet\n\n### Battery life\n',
      transcript: 'tick 1 speech',
      where: 'ES2002a tick 1',
    });
    // Held, so nothing has been judged yet.
    expect(window.judged).toBe(0);
    expect(window.flush()).not.toBeNull();
    expect(window.judged).toBe(1);
    expect(window.waited).toBe(0);
  });

  test('a window that waited for a tick is told apart from one that did not', async () => {
    const windows = await windowsFor(
      [
        [{ heading: BATTERY }],
        [{ under: BATTERY, markdown: '- a year on a coin cell' }],
        [{ under: BEEP, markdown: '- the beep has to be loud' }],
      ],
      [0, 2],
    );
    expect(windows).toHaveLength(2);
  });
});
