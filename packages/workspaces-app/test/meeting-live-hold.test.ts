import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COLLAPSE_MS,
  FADE_MS,
  NOTE_LAND_MS,
  createMeetingLiveZone,
} from '../src/meeting-live-zone.ts';

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

/**
 * The stream is held over the break the split makes in its line.
 *
 * The composing turns and the one still being spoken share a line, and
 * lifting the first into a block ends that line: without the hold the live
 * words drop a line and jump back to the margin, on the one frame the settle
 * promises nothing moves on. Measured in Chrome at 1180x820 before the fix:
 * 186.31 to 209.56 down, 152.88 to 40 across.
 *
 * happy-dom lays nothing out, so those pixels are GIVEN to it here. The stub
 * answers with the geometry a browser produced, and it keys off the same
 * thing the browser does — whether a chunk block exists yet — so the module
 * is driven, not described. What it cannot show is the geometry itself; that
 * is the browser measurement in the PR.
 */
describe('a split leaves the words still being spoken where they were', () => {
  const SETTLED = 'the settled thought.';
  const LIVE = 'still talking';
  /** Where each turn sits before the split, and where the survivor lands
   *  after it — one line down, back at the left margin. */
  const BEFORE: Record<string, [number, number]> = {
    [SETTLED]: [163.06, 40],
    [LIVE]: [186.31, 152.88],
  };
  const AFTER: Record<string, [number, number]> = { [LIVE]: [209.56, 40] };

  let realRects: (() => DOMRectList) | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    realRects = Element.prototype.getClientRects;
    Element.prototype.getClientRects = function fake(this: Element) {
      // The chunk's block is what ends the shared line, in the browser and
      // here: before it exists the live turn continues after the tail.
      const at = (document.querySelector('.lz-slot') ? AFTER : BEFORE)[this.textContent ?? ''];
      return (at ? [{ top: at[0], left: at[1] }] : []) as unknown as DOMRectList;
    };
  });
  afterEach(() => {
    if (realRects) Element.prototype.getClientRects = realRects;
    vi.useRealTimers();
  });

  const split = (): { zone: ReturnType<typeof createMeetingLiveZone>; lines: HTMLElement } => {
    const zone = createMeetingLiveZone({ parent, now, reducedMotion: () => false });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: SETTLED, final: true });
    zone.onTurn({ turn: 1, text: LIVE, final: false });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    const lines = zoneEl().querySelector<HTMLElement>('.lz-lines');
    if (!lines) throw new Error('no .lz-lines');
    return { zone, lines };
  };

  it('holds the stream on the pixel it was on, both ways', () => {
    const { lines } = split();
    // Exactly the displacement, negated: up a line, and out to where the
    // chunk's tail ended.
    expect(lines.style.getPropertyValue('--lz-hold-y')).toBe('-23.25px');
    expect(lines.style.getPropertyValue('--lz-hold-x')).toBe('112.88px');
  });

  it('holds nothing when the split fell on a line start already', () => {
    // The control: the same code path, a survivor the split does not move,
    // and no hold — otherwise the assertion above would pass on a zone that
    // compensates unconditionally.
    AFTER[LIVE] = BEFORE[LIVE] as [number, number];
    try {
      const { lines } = split();
      expect(lines.style.getPropertyValue('--lz-hold-y')).toBe('');
      expect(lines.style.getPropertyValue('--lz-hold-x')).toBe('');
    } finally {
      AFTER[LIVE] = [209.56, 40];
    }
  });

  it('holds through the land and the fade, and lets go with the collapse', () => {
    const { zone, lines } = split();
    zone.onProgress({ tick: 1, phase: 'written', turns: [0] });

    // Nothing moves for the whole of the hold and the fade — the interval
    // the slot's pinned height exists to protect.
    vi.advanceTimersByTime(NOTE_LAND_MS + FADE_MS - 1);
    expect(lines.style.getPropertyValue('--lz-hold-y')).toBe('-23.25px');
    expect(lines.classList.contains('is-releasing')).toBe(false);

    // The collapse is the one beat the stream is meant to travel on, so the
    // hold goes then, over the collapse's own length.
    vi.advanceTimersByTime(1);
    expect(lines.style.getPropertyValue('--lz-hold-y')).toBe('');
    expect(lines.style.getPropertyValue('--lz-hold-x')).toBe('');
    expect(lines.classList.contains('is-releasing')).toBe(true);
    vi.advanceTimersByTime(COLLAPSE_MS);
    expect(lines.classList.contains('is-releasing')).toBe(false);
  });

  /** happy-dom lays nothing out, so the stream's box is GIVEN a height: the
   *  two lines the indent made of it at 430px, 42px in Chrome. */
  const boxOf = (lines: HTMLElement, height: number): void => {
    lines.getBoundingClientRect = () => ({ height }) as DOMRect;
    Object.defineProperty(lines, 'scrollHeight', { value: height, configurable: true });
  };

  it('the collapse keeps the box as tall as it was, so a re-wrap cannot take a line', () => {
    const { zone, lines } = split();
    boxOf(lines, 42);
    zone.onProgress({ tick: 1, phase: 'written', turns: [0] });
    vi.advanceTimersByTime(NOTE_LAND_MS + FADE_MS);
    expect(lines.style.minHeight).toBe('42px');
    // …and keeps it once the release has eased out: the space is the next
    // words' to fill, not the layout's to take.
    vi.advanceTimersByTime(COLLAPSE_MS);
    expect(lines.style.minHeight).toBe('42px');
  });

  it('gives the reserve back only once the words have outgrown it', () => {
    const { zone, lines } = split();
    boxOf(lines, 42);
    zone.onProgress({ tick: 1, phase: 'written', turns: [0] });
    vi.advanceTimersByTime(NOTE_LAND_MS + FADE_MS + COLLAPSE_MS);
    // A turn that leaves the stream at the reserved height: nothing to give.
    zone.onTurn({ turn: 2, text: 'a few more words', final: false });
    expect(lines.style.minHeight).toBe('42px');
    // The stream grows past it — three lines now — and the reserve goes,
    // which moves nothing because the words already fill the space.
    boxOf(lines, 63);
    zone.onTurn({ turn: 3, text: 'and a third line of them', final: false });
    expect(lines.style.minHeight).toBe('');
  });

  it('a new split on a reserved stream keeps the reserve — taking it back would step the line', () => {
    const { zone, lines } = split();
    boxOf(lines, 42);
    zone.onProgress({ tick: 1, phase: 'written', turns: [0] });
    vi.advanceTimersByTime(NOTE_LAND_MS + FADE_MS + COLLAPSE_MS);
    zone.onTurn({ turn: 2, text: LIVE, final: false });
    zone.onProgress({ tick: 2, phase: 'composing', turns: [1] });
    expect(lines.style.minHeight).toBe('42px');
  });

  it('a failed tick keeps no height: its words come back and the box grows anyway', () => {
    const { zone, lines } = split();
    boxOf(lines, 42);
    zone.onProgress({ tick: 1, phase: 'failed', turns: [0] });
    expect(lines.style.minHeight).toBe('');
  });

  it('the meeting ending drops the reserve with the hold', () => {
    const { zone, lines } = split();
    boxOf(lines, 42);
    zone.onProgress({ tick: 1, phase: 'written', turns: [0] });
    vi.advanceTimersByTime(NOTE_LAND_MS + FADE_MS);
    expect(lines.style.minHeight).toBe('42px');
    zone.end();
    expect(lines.style.minHeight).toBe('');
  });

  it('a failed tick puts the words back, so there is nothing left to hold', () => {
    const { zone, lines } = split();
    zone.onProgress({ tick: 1, phase: 'failed', turns: [0] });
    expect(lines.style.getPropertyValue('--lz-hold-y')).toBe('');
    expect(lines.classList.contains('is-releasing')).toBe(false);
  });

  it('the meeting ending drops the hold with the chunk', () => {
    const { zone, lines } = split();
    zone.end();
    expect(lines.style.getPropertyValue('--lz-hold-y')).toBe('');
  });
});

/**
 * The settle that cannot lift.
 *
 * A later tick can compose words with a SURVIVOR IN FRONT of them. Lifted into
 * a chunk anyway, those words leave the middle of the run and the hold pulls
 * the stream a whole line up onto them: 157.5px of one line painted over
 * another, measured in Chrome at 1180x820 and again at 430. The geometry is
 * `meeting-live-overdraw.test.ts`, which drives a whole meeting through a real
 * browser; what is checked here is the decision — which settle each split
 * gets, and the two beats the in-place one runs on.
 *
 * THE SURVIVOR IS A CARRIED TURN, and that is how the stream comes to have
 * one. A failed tick's words go back into the session's `carry`; the next tick
 * composes them, but `composeTick` announces `composing` for THAT TICK'S OWN
 * turns only (meeting-notes.ts), so the carried ones are never named and stay
 * unflagged at the head of the run.
 *
 * It used to be an `empty` tick instead, whose words the server drops from its
 * carry and which therefore sat at the head of the stream for the rest of the
 * meeting. They do not sit there any more — see the live-zone suite — so the
 * case is built on the route that is still real.
 */
describe('words with a survivor in front of them fade where they sit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A stream whose head is a carried turn — a failed tick's words, which the
   *  next tick composes without naming — and a later tick composing the words
   *  after it. */
  const stranded = (): ReturnType<typeof createMeetingLiveZone> => {
    const zone = createMeetingLiveZone({ parent, now, reducedMotion: () => false });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'the words no note ever covered', final: true });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    zone.onProgress({ tick: 1, phase: 'failed', turns: [0] });
    zone.onTurn({ turn: 1, text: 'and what was said after them', final: true });
    zone.onTurn({ turn: 2, text: 'still talking', final: false });
    zone.onProgress({ tick: 2, phase: 'composing', turns: [1] });
    return zone;
  };
  const turnEls = (): HTMLElement[] => [...zoneEl().querySelectorAll<HTMLElement>('.lz-turn')];
  const textOf = (): string => zoneEl().querySelector('.lz-lines')?.textContent ?? '';

  it('lifts nothing into a chunk, and marks the words where they are', () => {
    stranded();
    expect(zoneEl().querySelector('.lz-slot')).toBe(null);
    // The words are still in the stream, in the order they were spoken, and
    // the one being composed wears the colour the chunk would have given it.
    expect(textOf()).toContain('the words no note ever covered');
    expect(textOf()).toContain('and what was said after them');
    const composing = turnEls().filter((el) => el.classList.contains('lz-chunk'));
    expect(composing).toHaveLength(1);
    expect(composing[0]?.textContent).toBe('and what was said after them');
  });

  it('a split at the front of the stream still lifts — the control', () => {
    // Without this the assertion above passes on a zone that stopped lifting
    // anything at all.
    const zone = createMeetingLiveZone({ parent, now, reducedMotion: () => false });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'the settled thought', final: true });
    zone.onTurn({ turn: 1, text: 'still talking', final: false });
    zone.onProgress({ tick: 1, phase: 'composing', turns: [0] });
    expect(zoneEl().querySelector('.lz-slot')).not.toBe(null);
    expect(textOf()).not.toContain('the settled thought');
  });

  it('runs the same two beats: the note lands, the words fade, then they go', () => {
    const zone = stranded();
    zone.onProgress({ tick: 2, phase: 'written', turns: [1] });

    // Beat one: the note lands and the page settles. Nothing has moved and
    // nothing has faded.
    vi.advanceTimersByTime(NOTE_LAND_MS - 1);
    expect(turnEls().some((el) => el.classList.contains('is-fading'))).toBe(false);
    vi.advanceTimersByTime(1);
    const fading = turnEls().filter((el) => el.classList.contains('is-fading'));
    expect(fading).toHaveLength(1);
    expect(fading[0]?.textContent).toBe('and what was said after them');

    // Beat two: the fade runs its length, and only then do the words leave
    // the run and the stream close over them.
    vi.advanceTimersByTime(FADE_MS - 1);
    expect(textOf()).toContain('and what was said after them');
    vi.advanceTimersByTime(1);
    expect(textOf()).not.toContain('and what was said after them');
    // The stranded head is untouched: no note ever covered it.
    expect(textOf()).toContain('the words no note ever covered');
  });

  it('a tick whose words are carried gives them straight back', () => {
    const zone = stranded();
    zone.onProgress({ tick: 2, phase: 'failed', turns: [1] });
    expect(turnEls().some((el) => el.classList.contains('lz-chunk'))).toBe(false);
    expect(textOf()).toContain('and what was said after them');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a tick that composes nothing takes its words with it, in place', () => {
    // No chunk to hand to a settle, and no note to wait for: the words fade
    // where they sit and the stream closes over them. What must NOT happen is
    // the old answer — leaving them in the run, where they read as still on
    // their way into the notes for the rest of the meeting.
    const zone = stranded();
    zone.onProgress({ tick: 2, phase: 'empty', turns: [1] });
    expect(turnEls().some((el) => el.classList.contains('lz-chunk'))).toBe(false);
    vi.advanceTimersByTime(FADE_MS + 1);
    expect(textOf()).not.toContain('and what was said after them');
  });

  it('a tick withdrawing mid-fade brings its words back, beat and all', () => {
    // A retry: the write landed, the fade started, and then the tick came
    // back `failed`. The words are no more written up than they were before,
    // so they return — and the beat that was taking them away has to die with
    // the claim, or they leave the stream anyway one frame later.
    const zone = stranded();
    zone.onProgress({ tick: 2, phase: 'written', turns: [1] });
    vi.advanceTimersByTime(NOTE_LAND_MS);
    expect(turnEls().some((el) => el.classList.contains('is-fading'))).toBe(true);

    zone.onProgress({ tick: 2, phase: 'failed', turns: [1] });
    expect(turnEls().some((el) => el.classList.contains('is-fading'))).toBe(false);
    expect(turnEls().some((el) => el.classList.contains('lz-chunk'))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(NOTE_LAND_MS + FADE_MS);
    expect(textOf()).toContain('and what was said after them');
  });

  it("another tick's withdrawal leaves a running fade alone", () => {
    // Two ticks are outstanding whenever one fires while another is still
    // composing, so a terminal frame naming turns this settle never had must
    // not cancel it. Cancelled, its words keep the composing flag with no beat
    // left to remove them — stranded in the stream for the rest of the
    // meeting, which is the bug this whole change is about.
    const zone = stranded();
    zone.onProgress({ tick: 2, phase: 'written', turns: [1] });
    vi.advanceTimersByTime(NOTE_LAND_MS);
    zone.onTurn({ turn: 3, text: 'the next thing said', final: true });
    zone.onProgress({ tick: 3, phase: 'composing', turns: [3] });
    zone.onProgress({ tick: 3, phase: 'failed', turns: [3] });

    // Tick 3 withdrew its own words; tick 2's fade is still running on its
    // own clock and finishes on time.
    expect(turnEls().some((el) => el.classList.contains('is-fading'))).toBe(true);
    vi.advanceTimersByTime(FADE_MS);
    expect(textOf()).not.toContain('and what was said after them');
    expect(textOf()).toContain('the next thing said');
  });

  it('two notes landing inside one window take both sets of words', () => {
    // One clock over the union, not a second one racing it: two clocks left
    // whichever finished first deleting only its own half, and the other half
    // flagged composing for the rest of the meeting.
    const zone = stranded();
    zone.onProgress({ tick: 2, phase: 'written', turns: [1] });
    zone.onTurn({ turn: 3, text: 'the next thing said', final: true });
    zone.onProgress({ tick: 3, phase: 'composing', turns: [3] });
    zone.onProgress({ tick: 3, phase: 'written', turns: [3] });

    vi.advanceTimersByTime(NOTE_LAND_MS + FADE_MS);
    expect(textOf()).not.toContain('and what was said after them');
    expect(textOf()).not.toContain('the next thing said');
    expect(textOf()).toContain('the words no note ever covered');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a second tick firing mid-fade neither lifts nor cuts the first short', () => {
    // Two ticks outstanding, which the server produces by announcing
    // `composing` per FIRING and reporting the outcome per COMPOSE. Nothing
    // here may be decided from what the LAST split concluded: the stranded
    // head is still in front of both, so neither may be lifted.
    const zone = stranded();
    zone.onProgress({ tick: 2, phase: 'written', turns: [1] });
    vi.advanceTimersByTime(NOTE_LAND_MS);
    zone.onTurn({ turn: 3, text: 'the next thing said', final: true });
    zone.onProgress({ tick: 3, phase: 'composing', turns: [3] });

    expect(zoneEl().querySelector('.lz-slot')).toBe(null);
    const marked = turnEls().filter((el) => el.classList.contains('lz-chunk'));
    expect(marked.map((el) => el.textContent)).toEqual([
      'and what was said after them',
      'the next thing said',
    ]);
    // The first settle keeps its own beat rather than being cut short by the
    // arrival of the second.
    vi.advanceTimersByTime(FADE_MS);
    expect(textOf()).not.toContain('and what was said after them');
    expect(textOf()).toContain('the next thing said');

    // And the new one is still a settle in place, not a chunk that mounted
    // once the last one's words left.
    zone.onProgress({ tick: 3, phase: 'written', turns: [3] });
    vi.advanceTimersByTime(NOTE_LAND_MS + FADE_MS);
    expect(zoneEl().querySelector('.lz-slot')).toBe(null);
    expect(textOf()).not.toContain('the next thing said');
  });

  it('a meeting that never reported a tick fades its settled words in place', () => {
    // `clearSettled` is the other caller of the two beats — the fallback for a
    // meeting whose notes surface reports nothing. A partial turn in front of
    // a settled one puts it on the in-place route as surely as a strand does.
    const zone = createMeetingLiveZone({ parent, now, reducedMotion: () => false });
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'a sentence still being spoken', final: false });
    zone.onTurn({ turn: 1, text: 'one that is finished', final: true });
    zone.clearSettled();

    expect(zoneEl().querySelector('.lz-slot')).toBe(null);
    expect(textOf()).toContain('one that is finished');
    vi.advanceTimersByTime(NOTE_LAND_MS + FADE_MS);
    expect(textOf()).not.toContain('one that is finished');
    expect(textOf()).toContain('a sentence still being spoken');
  });

  it('the zone going away takes the fade with it', () => {
    const zone = stranded();
    zone.onProgress({ tick: 2, phase: 'written', turns: [1] });
    vi.advanceTimersByTime(NOTE_LAND_MS);
    zone.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the meeting ending takes the fade with it', () => {
    const zone = stranded();
    zone.onProgress({ tick: 2, phase: 'written', turns: [1] });
    vi.advanceTimersByTime(NOTE_LAND_MS);
    zone.end();
    expect(zoneEl().hidden).toBe(true);
    vi.advanceTimersByTime(NOTE_LAND_MS + FADE_MS);
    expect(zoneEl().hidden).toBe(true);
    // And the next meeting starts clean rather than under the last one's
    // fade: a beat still running would mark its first words on arrival.
    expect(vi.getTimerCount()).toBe(0);
    zone.begin(now());
    zone.onTurn({ turn: 0, text: 'a new meeting', final: true });
    expect(textOf()).toBe('a new meeting');
    expect(turnEls().some((el) => el.classList.contains('is-fading'))).toBe(false);
  });
});
