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
