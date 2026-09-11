import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLLAPSE_MS,
  FADE_MS,
  NOTE_LAND_MS,
  WASH_GRACE_MS,
  createMeetingLiveZone,
} from '../src/meeting-live-zone.ts';

/**
 * The provisional zone (meeting-notes UX plan, AC 3/4): the live transcript
 * at the end of the doc as ONE run of text — no per-turn stamps or blocks
 * (owner, 2026-09-01: "engine turns have no meaning or value to the
 * viewer") — speaker pills only once a second voice is heard, the
 * splitting-off card while a tick composes, and words leaving the zone the
 * moment their note is written.
 */

let parent: HTMLElement;
let clock: number;
const now = (): number => clock;

beforeEach(() => {
  document.body.innerHTML = '';
  parent = document.createElement('div');
  document.body.append(parent);
  clock = 100_000;
});

const zoneEl = (): HTMLElement => {
  const el = parent.querySelector<HTMLElement>('.live-zone');
  if (!el) throw new Error('no .live-zone rendered');
  return el;
};
const turns = (): string[] =>
  [...zoneEl().querySelectorAll<HTMLElement>('.lz-lines .lz-turn')].map((l) => l.textContent ?? '');
const stream = (): string => zoneEl().querySelector('.lz-lines')?.textContent ?? '';
const chunkEl = (): HTMLElement | null => zoneEl().querySelector<HTMLElement>('.lz-chunk');
const slotEl = (): HTMLElement | null => zoneEl().querySelector<HTMLElement>('.lz-slot');

describe('the provisional live zone', () => {
  it('is hidden until a live meeting has words, and renders after the editor content', () => {
    const zone = createMeetingLiveZone({ parent, now });
    expect(zoneEl().hidden).toBe(true);
    zone.begin(now());
    expect(zoneEl().hidden).toBe(true);
    zone.onTurn({ turn: 0, text: 'hello', final: false });
    expect(zoneEl().hidden).toBe(false);
    expect(zoneEl().querySelector('.lz-label')?.textContent).toBe('Live transcript');
    // Appended last: at the end of the doc, under whatever the parent holds.
    expect(parent.lastElementChild).toBe(zoneEl());
  });

  it('a turn arriving before begin() is dropped — nothing owns the zone yet', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.onTurn({ turn: 0, text: 'stray', final: true });
    expect(zoneEl().hidden).toBe(true);
  });

  it('renders N finals as one run of text: no stamps, no blocks, a space between turns', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    clock += 258_000;
    zone.onTurn({ turn: 0, text: 'the first ver', final: false });
    clock += 12_000;
    zone.onTurn({ turn: 0, text: 'The first version, corrected.', final: true });
    zone.onTurn({ turn: 1, text: 'Then a few more words', final: true });
    zone.onTurn({ turn: 2, text: 'and the rest of the sentence.', final: true });
    const lines = zoneEl().querySelector<HTMLElement>('.lz-lines');
    if (!lines) throw new Error('no .lz-lines');
    // No mm:ss anywhere in the stream — a turn's arrival time is the
    // engine's business, not the reader's.
    expect(lines.textContent).not.toMatch(/\b\d\d:\d\d\b/);
    expect(lines.querySelector('.lz-ts')).toBeNull();
    // Every child is inline: a span per turn, a text node between, nothing
    // block-level, so the words wrap as one paragraph.
    for (const child of [...lines.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        expect(child.textContent).toBe(' ');
        continue;
      }
      expect((child as Element).tagName).toBe('SPAN');
      expect((child as Element).classList.contains('lz-turn')).toBe(true);
    }
    expect(lines.querySelector('div, p, li')).toBeNull();
    expect(stream()).toBe(
      'The first version, corrected. Then a few more words and the rest of the sentence.',
    );
  });

  it('keeps a line break the engine put in a turn, and adds none of its own', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'First paragraph.\nSecond paragraph.', final: true });
    zone.onTurn({ turn: 1, text: 'No break before this.', final: true });
    const lines = zoneEl().querySelector<HTMLElement>('.lz-lines');
    if (!lines) throw new Error('no .lz-lines');
    expect(lines.querySelectorAll('br')).toHaveLength(1);
    const first = lines.querySelector('.lz-turn');
    expect(first?.querySelector('br')).not.toBeNull();
    expect(turns()).toEqual(['First paragraph.Second paragraph.', 'No break before this.']);
  });

  it('only the line still being spoken carries the caret', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'done.', final: true });
    zone.onTurn({ turn: 1, text: 'still going', final: false });
    const rendered = [...zoneEl().querySelectorAll<HTMLElement>('.lz-turn')];
    expect(rendered.map((l) => l.classList.contains('lz-partial'))).toEqual([false, true]);
  });

  it('speaker pills appear only once a second voice has been heard, and only where the voice changes', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'just me so far.', final: true, speaker: 'A' });
    zone.onTurn({ turn: 1, text: 'still me.', final: true, speaker: 'A' });
    expect(zoneEl().querySelector('.lz-speaker')).toBeNull();
    zone.onTurn({ turn: 2, text: 'a second voice.', final: true, speaker: 'B' });
    zone.onTurn({ turn: 3, text: 'the same voice, going on', final: false, speaker: 'B' });
    // One pill per run of a voice — the engine's turn boundaries inside a
    // run are not the reader's.
    const pills = [...zoneEl().querySelectorAll<HTMLElement>('.lz-speaker')];
    expect(pills.map((p) => p.textContent)).toEqual(['Speaker A', 'Speaker B']);
    zone.setNames({ A: 'Dana' });
    expect(
      [...zoneEl().querySelectorAll<HTMLElement>('.lz-speaker')].map((p) => p.textContent),
    ).toEqual(['Dana', 'Speaker B']);
  });

  it('the pill is the rename control while a meeting runs — a button, named for a11y', () => {
    const named: string[] = [];
    const zone = createMeetingLiveZone({ parent, now, nameSpeaker: (l) => named.push(l) });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'A' });
    zone.onTurn({ turn: 1, text: 'Sure.', final: true, speaker: 'B' });
    const pills = [...zoneEl().querySelectorAll<HTMLElement>('.lz-speaker')];
    expect(pills.map((p) => p.tagName)).toEqual(['BUTTON', 'BUTTON']);
    // The pencil is a stylesheet ::before, so the accessible name is given
    // here or a screen reader hears the name and no verb.
    expect(pills.map((p) => p.getAttribute('aria-label'))).toEqual([
      'Name Speaker A',
      'Name Speaker B',
    ]);
    pills[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(named).toEqual(['B']);
    // And the answer comes back through setNames, on the pill already drawn.
    zone.setNames({ B: 'Priya' });
    const after = [...zoneEl().querySelectorAll<HTMLElement>('.lz-speaker')];
    expect(after.map((p) => p.textContent)).toEqual(['Speaker A', 'Priya']);
    expect(after[1]?.getAttribute('aria-label')).toBe('Name Priya');
  });

  it('with no way to record a name the pill stays a label — no promise it cannot keep', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'A' });
    zone.onTurn({ turn: 1, text: 'Sure.', final: true, speaker: 'B' });
    const pills = [...zoneEl().querySelectorAll<HTMLElement>('.lz-speaker')];
    expect(pills.map((p) => p.tagName)).toEqual(['SPAN', 'SPAN']);
    expect(pills.some((p) => p.hasAttribute('aria-label'))).toBe(false);
  });

  it('a two-stream meeting’s pills say which side of the call a voice is on', () => {
    // Both engines hand out "A", so the pill has to carry the group or the
    // room and the call read as one person talking to themselves.
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'in the room.', final: true, speaker: 'room:A' });
    zone.onTurn({ turn: 1, text: 'on the call.', final: true, speaker: 'remote:A' });
    expect(
      [...zoneEl().querySelectorAll<HTMLElement>('.lz-speaker')].map((p) => p.textContent),
    ).toEqual(['Room Speaker A', 'Remote Speaker A']);
    // A NAMED VOICE DROPS THE GROUP. It used to keep it — "Dana (Remote)" —
    // and Bryan asked for that gone on 2026-09-09: the group tells two
    // anonymous voices apart, and a name already does that job.
    zone.setNames({ 'remote:A': 'Dana' });
    expect(
      [...zoneEl().querySelectorAll<HTMLElement>('.lz-speaker')].map((p) => p.textContent),
    ).toEqual(['Room Speaker A', 'Dana']);
  });

  it('composing splits the tick’s lines off with nothing drawn around them, and the rest streams on', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'the settled thought.', final: true });
    zone.onTurn({ turn: 1, text: 'the next one, mid-air', final: false });
    expect(chunkEl()).toBeNull(); // no block until a tick actually splits one

    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    const chunk = chunkEl();
    if (!chunk) throw new Error('no chunk');
    expect(chunk.textContent).toContain('the settled thought.');
    // The chunk IS the stream's type, and nothing is drawn in its place: the
    // "Writing this into the notes above…" line and its spinner are gone
    // (owner, 2026-09-05 — both took up space and shifted the words).
    expect(chunk.classList.contains('lz-chunk-lines')).toBe(true);
    expect(zoneEl().querySelector('.lz-chunk-note')).toBeNull();
    expect(zoneEl().querySelector('.lz-spinner')).toBeNull();
    expect(zoneEl().textContent).not.toContain('Writing this into the notes');
    // The remainder keeps streaming below.
    expect(turns()).toEqual(['the next one, mid-air']);
  });

  it('a failed tick returns its lines to the stream — they are still provisional', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'carried words.', final: true });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    expect(chunkEl()).not.toBeNull(); // control: it really was split off
    zone.onProgress({ tick: 1, phase: 'failed', turns: [0] });
    // Nothing settled, so the block goes at once — no fade, no collapse.
    expect(chunkEl()).toBeNull();
    expect(turns()).toEqual(['carried words.']);
  });

  it('an empty tick drops the chunk it was lifted into — no note landed in it', () => {
    // The chunk goes with no settle, exactly as a failed tick's does: the
    // settle is the animation that means a note arrived, and none did. The
    // words themselves then leave the stream, which is the case below.
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'nothing worth noting.', final: true });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    expect(chunkEl()).not.toBeNull(); // control: it really was split off
    zone.onProgress({ tick: 1, phase: 'empty', turns: [0] });
    expect(chunkEl()).toBeNull();
    expect(turns()).toEqual(['nothing worth noting.']);
  });

  it('clearSettled lifts final lines into a chunk and keeps the one being spoken', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'written by the bot path.', final: true });
    zone.onTurn({ turn: 1, text: 'still talking', final: false });
    zone.clearSettled();
    expect(turns()).toEqual(['still talking']);
    // Lifted, not deleted: the bot path leaves by the same fade every other
    // path uses rather than blinking out of the stream.
    expect(chunkEl()?.textContent).toContain('written by the bot path.');
  });

  it('end() hides and forgets; the wash stays armed for the grace window only', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'words.', final: true });
    expect(zone.active()).toBe(true);
    zone.end();
    expect(zone.active()).toBe(false);
    expect(zoneEl().hidden).toBe(true);
    // The end tick's note lands seconds after `stopped` — it still washes…
    expect(zone.washActive()).toBe(true);
    // …but a remote edit long after the meeting does not.
    clock += WASH_GRACE_MS + 1;
    expect(zone.washActive()).toBe(false);
  });

  it('a held wash outlives the grace window, and never shortens one', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'words.', final: true });
    zone.end();
    // A tidy-up asked for long after the stop: the notes it writes are the
    // freshest thing on the page and must still tint.
    clock += WASH_GRACE_MS + 1;
    expect(zone.washActive()).toBe(false);
    zone.holdWash(60_000);
    expect(zone.washActive()).toBe(true);
    // A second, shorter hold cannot cut the first one short.
    zone.holdWash(1);
    clock += 30_000;
    expect(zone.washActive()).toBe(true);
    clock += 30_001;
    expect(zone.washActive()).toBe(false);
  });

  it('destroy removes the zone element', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.destroy();
    expect(parent.querySelector('.live-zone')).toBeNull();
  });
});

/**
 * The settle (approved settle mock, round 2). The words do not
 * disappear with their turns: the block holding them stays where it is,
 * holds while the note lands, fades in place, and only then collapses the
 * space it held.
 *
 * happy-dom lays nothing out, so the "nothing below it moves" claim is a
 * BROWSER measurement (recorded in the PR). What is guarded here is the
 * mechanism that produces it: the slot's height is pinned before the fade
 * starts and is not touched again until the collapse begins.
 */
describe('a settled chunk fades where it sits, then collapses', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const settling = (): { zone: ReturnType<typeof createMeetingLiveZone>; slot: HTMLElement } => {
    const zone = createMeetingLiveZone({ parent, now, reducedMotion: () => false });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'the settled thought.', final: true });
    zone.onTurn({ turn: 1, text: 'still talking', final: false });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    zone.onProgress({ tick: 1, phase: 'written', turns: [0] });
    const slot = slotEl();
    if (!slot) throw new Error('the chunk left the zone the moment its turns did');
    return { zone, slot };
  };

  it('holds the words on screen after `written`, at a pinned height', () => {
    const { slot } = settling();
    // The turns are gone from the model…
    expect(turns()).toEqual(['still talking']);
    // …but their words are still on the page, not yet fading.
    expect(slot.textContent).toContain('the settled thought.');
    expect(chunkEl()?.classList.contains('is-fading')).toBe(false);
    // Pinned before anything animates, so the fade cannot change the height.
    expect(slot.style.height).toBe('0px'); // happy-dom measures every box at 0
  });

  it('fades only after the note has had time to land, and collapses only after the fade', () => {
    const { slot } = settling();
    const pinned = slot.style.height;

    vi.advanceTimersByTime(NOTE_LAND_MS - 1);
    expect(chunkEl()?.classList.contains('is-fading')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(chunkEl()?.classList.contains('is-fading')).toBe(true);

    // Through the whole fade the slot keeps the height it was pinned at and
    // the collapse has not started — this is the interval the browser
    // measurement checks nothing below it moves in.
    vi.advanceTimersByTime(FADE_MS - 1);
    expect(slot.classList.contains('is-collapsing')).toBe(false);
    expect(slot.style.height).toBe(pinned);

    vi.advanceTimersByTime(1);
    expect(slot.classList.contains('is-collapsing')).toBe(true);
    expect(slot.style.height).toBe('0px');

    // Gone once the collapse has run, and the zone with it — nothing left.
    vi.advanceTimersByTime(COLLAPSE_MS);
    expect(slotEl()).toBeNull();
  });

  it('reduced motion keeps the cross-fade and drops only the travel', () => {
    const zone = createMeetingLiveZone({ parent, now, reducedMotion: () => true });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'the settled thought.', final: true });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    zone.onProgress({ tick: 1, phase: 'written', turns: [0] });

    // Not a cut: the words are still there, and they still fade — the owner
    // tried the instant swap and called it too sudden (2026-09-05).
    vi.advanceTimersByTime(NOTE_LAND_MS - 1);
    expect(chunkEl()?.textContent).toContain('the settled thought.');
    expect(chunkEl()?.classList.contains('is-fading')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(chunkEl()?.classList.contains('is-fading')).toBe(true);

    // The fade runs its full length…
    vi.advanceTimersByTime(FADE_MS - 1);
    expect(slotEl()?.classList.contains('is-collapsing')).toBe(false);
    // …and it is the COLLAPSE that loses its travel, not the fade.
    vi.advanceTimersByTime(1);
    const slot = slotEl();
    expect(slot?.classList.contains('is-collapsing')).toBe(true);
    expect(slot?.style.getPropertyValue('--lz-collapse-ms')).toBe('0ms');
    // No travel to wait out: the slot goes on the very next tick, where the
    // full-motion path is still COLLAPSE_MS from being done.
    vi.advanceTimersByTime(1);
    expect(slotEl()).toBeNull();
  });

  it('a second tick settles behind the first without disturbing it', () => {
    const { zone, slot } = settling();
    zone.onTurn({ turn: 1, text: 'still talking, finished now.', final: true });
    zone.onProgress({ tick: 2, phase: 'composing', turns: [1] });
    const slots = zoneEl().querySelectorAll('.lz-slot');
    expect(slots).toHaveLength(2);
    // Order on the page is the order they settled: the older one stays above.
    expect(slots[0]).toBe(slot);
    expect(slots[1]?.textContent).toContain('still talking, finished now.');
  });

  it('the bot fallback leaves by the same two beats: fade, then collapse', () => {
    const zone = createMeetingLiveZone({ parent, now, reducedMotion: () => false });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'the bot wrote this up.', final: true });
    // No progress frames on this path — a remote note insert is all the zone
    // is told.
    zone.clearSettled();
    const slot = slotEl();
    if (!slot) throw new Error('clearSettled took the words with no settle');
    expect(slot.textContent).toContain('the bot wrote this up.');

    vi.advanceTimersByTime(NOTE_LAND_MS - 1);
    expect(chunkEl()?.classList.contains('is-fading')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(chunkEl()?.classList.contains('is-fading')).toBe(true);
    vi.advanceTimersByTime(FADE_MS);
    expect(slot.classList.contains('is-collapsing')).toBe(true);
    vi.advanceTimersByTime(COLLAPSE_MS);
    expect(slotEl()).toBeNull();
  });

  it('a note landing mid-compose does not tear the chunk off before its fade', () => {
    // The doc's Yjs update and the `written` frame are the same event over
    // two channels, and the update can win. The fallback used to delete the
    // composing turn on that update, and the next render pulled the block off
    // the page instantly — the words vanished a beat BEFORE the fade they
    // were about to get.
    const zone = createMeetingLiveZone({ parent, now, reducedMotion: () => false });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'the settled thought.', final: true });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    zone.clearSettled();
    expect(chunkEl()?.textContent).toContain('the settled thought.');

    zone.onProgress({ tick: 1, phase: 'written', turns: [0] });
    const slot = slotEl();
    if (!slot) throw new Error('the chunk was gone before the settle could start');
    vi.advanceTimersByTime(NOTE_LAND_MS - 1);
    expect(chunkEl()?.classList.contains('is-fading')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(chunkEl()?.classList.contains('is-fading')).toBe(true);
  });

  it('the fallback stands down once a meeting reports its ticks', () => {
    // A doc insert says only "a note landed". On a meeting with frames the
    // frames already say WHICH words it carried, and the words spoken since
    // are not among them — sweeping them here faded away a sentence no note
    // was about.
    const { zone } = settling();
    zone.onTurn({ turn: 1, text: 'still talking, finished now.', final: true });
    zone.onTurn({ turn: 2, text: 'and a new thought', final: false });
    zone.clearSettled();
    expect(turns()).toEqual(['still talking, finished now.', 'and a new thought']);
  });

  it('the meeting ending drops a chunk mid-settle rather than leaving it behind', () => {
    const { zone } = settling();
    vi.advanceTimersByTime(NOTE_LAND_MS);
    zone.end();
    expect(slotEl()).toBeNull();
    expect(zoneEl().hidden).toBe(true);
    // And no timer left to resurrect it.
    vi.advanceTimersByTime(FADE_MS + COLLAPSE_MS);
    expect(slotEl()).toBeNull();
  });
});

/**
 * Layout stand-ins: happy-dom lays nothing out, so the pane and the zone
 * report the geometry the test declares. `zoneBottom` is the zone's bottom
 * in the pane's content coordinates; the pane is `viewport` tall.
 */
function fakeLayout(opts: { viewport: number; zoneBottom: () => number; proseWidth?: number }) {
  let scrollTop = 0;
  /** Every write to the pane's offset that did not come from `scroll` — the
   *  page moving on its own. */
  let writes = 0;
  Object.defineProperty(parent, 'clientHeight', { value: opts.viewport, configurable: true });
  Object.defineProperty(parent, 'scrollTop', {
    get: () => scrollTop,
    set: (v: number) => {
      writes++;
      scrollTop = v;
    },
    configurable: true,
  });
  parent.getBoundingClientRect = () => ({ top: 0, bottom: opts.viewport }) as DOMRect;
  zoneEl().getBoundingClientRect = () =>
    ({ top: opts.zoneBottom() - 40 - scrollTop, bottom: opts.zoneBottom() - scrollTop }) as DOMRect;
  const prose = document.createElement('div');
  prose.getBoundingClientRect = () => ({ width: opts.proseWidth ?? 0 }) as DOMRect;
  return {
    prose,
    /** The reader scrolls — the one thing allowed to move the pane. */
    scroll: (to: number) => {
      scrollTop = to;
      parent.dispatchEvent(new Event('scroll'));
    },
    top: () => scrollTop,
    writes: () => writes,
  };
}

/**
 * Owner's call, 2026-09-11 — "Never follow": the page never moves on its own;
 * new text arrives below the fold and the reader scrolls down when they want
 * it. The pull toward the transcript is what took the comments beside the
 * text above out of reach.
 */
describe('the live zone never moves the page', () => {
  it('leaves the pane where it is when the transcript grows past the bottom edge', () => {
    const zone = createMeetingLiveZone({ parent, now });
    let bottom = 300;
    const lay = fakeLayout({ viewport: 500, zoneBottom: () => bottom });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'fits', final: false });
    // From here the zone's bottom is 400px past the pane's bottom edge.
    bottom = 900;
    zone.onTurn({ turn: 0, text: 'fits and then some more words', final: true });
    zone.onTurn({ turn: 1, text: 'and another turn after it', final: false });
    expect(lay.top()).toBe(0);
    expect(lay.writes()).toBe(0);
  });

  it('leaves a reader parked at the foot where they are, through a whole settle', () => {
    vi.useFakeTimers();
    try {
      const zone = createMeetingLiveZone({ parent, now, reducedMotion: () => false });
      let bottom = 900;
      const lay = fakeLayout({ viewport: 500, zoneBottom: () => bottom });
      zone.begin(now());
      zone.onTurn({ turn: 0, text: 'a line', final: true });
      // The reader scrolls down to watch the words, by hand.
      lay.scroll(412);
      bottom = 1020;
      zone.onTurn({ turn: 1, text: 'a line, and more said after it', final: false });
      zone.onProgress({ tick: 0, phase: 'composing', turns: [0] });
      zone.onProgress({ tick: 0, phase: 'written', turns: [0] });
      vi.advanceTimersByTime(NOTE_LAND_MS + FADE_MS + COLLAPSE_MS);
      expect(lay.top()).toBe(412);
      expect(lay.writes()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("copies the prose column's width so the two coincide exactly", () => {
    const zone = createMeetingLiveZone({ parent, now, prose: document.createElement('div') });
    const lay = fakeLayout({ viewport: 500, zoneBottom: () => 100, proseWidth: 678 });
    // The prose handed in at creation reports no layout in happy-dom; swap
    // in the measured one through the same option shape.
    zone.destroy();
    const zone2 = createMeetingLiveZone({ parent, now, prose: lay.prose });
    fakeLayout({ viewport: 500, zoneBottom: () => 100, proseWidth: 678 });
    zone2.begin(now());
    zone2.onTurn({ turn: 0, text: 'hello', final: false });
    expect(zoneEl().style.width).toBe('678px');
  });
});

/**
 * The live transcript must not keep words the note-taker is finished with.
 *
 * WHAT A MEETING REPORTED. In a five-minute recording, phrases from early in
 * the meeting sat in the live transcript for the rest of it while later
 * phrases faded out around them — so the zone read as a backlog that was
 * never going to clear, and the reader could not tell which of the words in
 * front of them were still on their way into the notes.
 *
 * THE TWO PHASES ARE NOT THE SAME PROMISE, and that is the whole of it. A
 * `failed` tick's words really are still coming: the session carries them
 * into the next tick and composes them again. An `empty` tick's are not —
 * the session marks those turns composed and never looks at them again — so
 * leaving them on screen says something about them that will never become
 * true.
 */
describe('words the note-taker is finished with leave the live transcript', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('an empty tick’s words go, and are not left behind by a later written tick', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'the early phrase.', final: true });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    zone.onProgress({ tick: 1, phase: 'empty', turns: [0] });
    // A second tick, which does write a note, and whose words leave the way
    // they always have. This is the pairing the report was about.
    zone.onTurn({ turn: 1, text: 'the later phrase.', final: true });
    zone.onProgress({ tick: 2, phase: 'composing', turns: [1] });
    zone.onProgress({ tick: 2, phase: 'written', turns: [1] });
    vi.advanceTimersByTime(NOTE_LAND_MS + FADE_MS + COLLAPSE_MS);
    expect(stream()).not.toContain('the later phrase.');
    // The one that used to stay for the rest of the meeting.
    expect(stream()).not.toContain('the early phrase.');
    expect(turns()).toEqual([]);
  });

  it('an empty tick’s words wait for no note that is not coming', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'nothing worth noting.', final: true });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    zone.onProgress({ tick: 1, phase: 'empty', turns: [0] });
    // Still there at the moment the frame lands: the fade is an animation,
    // not a cut, so the words do not blink out from under the reader.
    expect(stream()).toContain('nothing worth noting.');
    // And gone one fade later — without the `NOTE_LAND_MS` beat that exists
    // to let an arriving note settle first, because none is arriving.
    vi.advanceTimersByTime(FADE_MS + 1);
    expect(stream()).not.toContain('nothing worth noting.');
  });

  it('a failed tick’s words stay: the next tick composes them again', () => {
    const zone = createMeetingLiveZone({ parent, now });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'carried words.', final: true });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    zone.onProgress({ tick: 1, phase: 'failed', turns: [0] });
    vi.advanceTimersByTime(NOTE_LAND_MS + FADE_MS + COLLAPSE_MS);
    expect(turns()).toEqual(['carried words.']);
  });
});
