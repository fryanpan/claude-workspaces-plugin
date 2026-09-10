/**
 * The meeting a browser has to survive: synthetic transcript deltas and
 * `notes_progress` frames pumped at the REAL live zone, with a sampler that
 * asks, every frame, whether two runs of text are painting on top of each
 * other.
 *
 * It is bundled into a page by `meeting-live-overdraw.test.ts` and driven over
 * CDP. Nothing here reads or asserts on source: it drives the module and
 * reports measured geometry, which is what testing standard 1 asks of a layout
 * check (`.claude/rules/testing-standards.md`).
 *
 * THE ENGINE MODEL IS THE REAL ONE. A turn arrives as a partial, is updated,
 * and finalises under the same id; ids only ever go up. A tick names some set
 * of finalised turns and reports `composing` and then one of `written`,
 * `empty` or `failed`. The one that matters is `empty`: the server drops those
 * turns from its carry (meeting-notes.ts refills `carry` on `failed`, not on
 * `empty`), so they stay in the stream for the rest of the meeting and every
 * later tick composes turns with a survivor in front of them.
 */
import { createMeetingLiveZone } from '../src/meeting-live-zone.ts';

/** One painted run of glyphs, already clipped the way the browser clips it. */
interface Painted {
  source: string;
  opacity: number;
  text: string;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/** The worst pair of painted runs found in one sample. */
export interface Overlap {
  area: number;
  width: number;
  height: number;
  a?: Painted;
  b?: Painted;
  mark?: string;
}

export interface DriveOptions {
  /** Note-writes to drive. */
  writes: number;
  /** Every Nth tick composes nothing and reports `empty`. 0 for none. */
  emptyEvery: number;
  /** Every Nth tick fails and reports `failed`. 0 for none. */
  failEvery: number;
  /** Fire a second split one beat into the last one's fade. */
  midSplit: boolean;
  /** Leave no quiet gap between one write and the next. */
  backToBack: boolean;
  /**
   * Scale every cadence — the settle's own JS steps and the CSS transitions
   * they wait on — by one factor, so a thirty-write meeting fits a test's
   * runtime with every ratio preserved. The same trick, and the same reason,
   * as the server suite's `CW_TEST_TIMING_SCALE`.
   */
  scale: number;
}

export interface DriveResult {
  /** Samples taken. Zero would make every reading below vacuous. */
  samples: number;
  /** The worst overlap seen across the whole meeting. */
  worst: Overlap;
  /** Note-writes that actually reported `written`. */
  written: number;
  /** Turns still in the stream at the end — the empty ticks' strandings. */
  stranded: number;
}

const opacityOf = (el: Element | null): number => {
  let o = 1;
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.visibility === 'hidden' || s.display === 'none') return 0;
    o *= Number.parseFloat(s.opacity || '1');
  }
  return o;
};

interface Box {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

/**
 * The clip the paint obeys and a Range does not.
 *
 * `Range.getClientRects()` reports a line of text at its full height even when
 * an ancestor is 3px tall with `overflow: hidden` — which is exactly what a
 * collapsing slot is for most of its life. Measured without this, the collapse
 * reads as a 605px² smear that no pixel on screen ever showed.
 */
function clipOf(el: Element | null): Box | null {
  let box: Box | null = null;
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
    const b = n.getBoundingClientRect();
    box =
      box === null
        ? { top: b.top, left: b.left, right: b.right, bottom: b.bottom }
        : {
            top: Math.max(box.top, b.top),
            left: Math.max(box.left, b.left),
            right: Math.min(box.right, b.right),
            bottom: Math.min(box.bottom, b.bottom),
          };
  }
  return box;
}

function glyphRects(root: Element, source: string, out: Painted[]): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue ?? '';
    if (!text.trim()) continue;
    const opacity = opacityOf(n.parentElement);
    if (opacity <= 0.02) continue;
    const clip = clipOf(n.parentElement);
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const rect of range.getClientRects()) {
      const top = clip ? Math.max(rect.top, clip.top) : rect.top;
      const left = clip ? Math.max(rect.left, clip.left) : rect.left;
      const right = clip ? Math.min(rect.right, clip.right) : rect.right;
      const bottom = clip ? Math.min(rect.bottom, clip.bottom) : rect.bottom;
      if (right - left > 0.5 && bottom - top > 0.5) {
        out.push({ source, opacity, text: text.trim().slice(0, 40), top, left, right, bottom });
      }
    }
  }
}

/** Every run the zone is painting, tagged by which run of text it belongs to. */
function painted(): Painted[] {
  const out: Painted[] = [];
  const lines = document.querySelector('.lz-lines');
  if (lines) glyphRects(lines, 'stream', out);
  document.querySelectorAll('.lz-slot').forEach((slot, i) => glyphRects(slot, `chunk${i}`, out));
  return out;
}

/**
 * The worst intersection between two runs of text that are not the same run.
 *
 * The settle deliberately leaves the stream's first line on the same LINE as
 * the chunk's tail — beside it, past the indent — so adjacency is expected and
 * only intersected area is a smear.
 */
export function worstOverlap(): Overlap {
  const rs = painted().sort((a, b) => a.top - b.top);
  let worst: Overlap = { area: 0, width: 0, height: 0 };
  for (let i = 0; i < rs.length; i++) {
    const a = rs[i] as Painted;
    for (let j = i + 1; j < rs.length; j++) {
      const b = rs[j] as Painted;
      if (b.top >= a.bottom) break; // sorted: nothing further down can overlap
      if (a.source === b.source) continue;
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (width <= 0.5 || height <= 0.5) continue;
      if (width * height > worst.area) worst = { area: width * height, width, height, a, b };
    }
  }
  return worst;
}

const WORDS = (
  'so the thing I keep coming back to is that we never wrote down what the acceptance bar was ' +
  'for that and it kept biting us every single week when the numbers came back different from ' +
  'what the dashboard said and nobody could tell which of the two was lying about it or whether ' +
  'we had simply measured the wrong week entirely and moved on without saying so'
).split(' ');

let wordAt = 0;
function speech(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[wordAt++ % WORDS.length] as string);
  return out.join(' ');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Scale the CSS half of the settle's clock to match the JS half. */
function scaleTransitions(scale: number): void {
  const style = document.createElement('style');
  style.textContent = `.live-zone{--lz-fade-ms:${Math.round(260 * scale)}ms;--lz-collapse-ms:${Math.round(440 * scale)}ms}`;
  document.head.append(style);
}

/**
 * Drive one meeting and report the worst overlap it ever painted.
 *
 * Installed on `window` so the CDP probe can await it; the page it runs in is
 * built by the test beside this file.
 */
async function drive(o: DriveOptions): Promise<string> {
  const editor = document.getElementById('editor') as HTMLElement;
  const prose = document.querySelector('.ProseMirror') as HTMLElement;
  const ms = (n: number): number => Math.round(n * o.scale);
  if (o.scale !== 1) {
    const real = window.setTimeout;
    // biome-ignore lint/suspicious/noExplicitAny: the timer's own signature
    window.setTimeout = ((fn: any, delay?: number, ...rest: any[]) =>
      real(fn, Math.max(0, ms(delay ?? 0)), ...rest)) as typeof window.setTimeout;
    scaleTransitions(o.scale);
  }

  const zone = createMeetingLiveZone({ parent: editor, prose, reducedMotion: () => false });
  zone.begin(Date.now());

  let samples = 0;
  let sampling = true;
  let mark = 'start';
  let worst: Overlap = { area: 0, width: 0, height: 0 };
  const sample = (): void => {
    if (!sampling) return;
    samples++;
    const w = worstOverlap();
    if (w.area > worst.area) worst = { ...w, mark };
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  let nextId = 0;
  let unwritten: number[] = [];
  let written = 0;

  /** One utterance: partial, partial, final — under one id, as the engine does. */
  async function utter(words: number): Promise<void> {
    const id = nextId++;
    zone.onTurn({ turn: id, text: speech(2), final: false, speaker: 'A' });
    await sleep(ms(60));
    zone.onTurn({ turn: id, text: speech(words), final: false, speaker: 'A' });
    await sleep(ms(60));
    zone.onTurn({ turn: id, text: speech(2), final: true, speaker: 'A' });
    unwritten.push(id);
  }
  /** A note lands in the doc — which is also what changes the prose's size. */
  function note(i: number): void {
    const li = document.createElement('li');
    const p = document.createElement('p');
    p.textContent = `Note ${i}: ${speech(5)}`;
    li.append(p);
    let ul = prose.querySelector('ul');
    if (!ul) {
      ul = document.createElement('ul');
      prose.append(ul);
    }
    ul.append(li);
  }
  const clear = (ids: readonly number[]): void => {
    unwritten = unwritten.filter((id) => !ids.includes(id));
  };

  for (let i = 0; i < o.writes; i++) {
    mark = `speaking-${i}`;
    await utter(7);
    await utter(6);
    const ids = unwritten.slice();
    mark = `composing-${i}`;
    zone.onProgress({ tick: i, phase: 'composing', turns: ids });
    // Words keep arriving while the tick composes.
    await utter(5);
    await sleep(ms(120));
    const empty = o.emptyEvery > 0 && (i + 1) % o.emptyEvery === 0;
    const failed = !empty && o.failEvery > 0 && (i + 1) % o.failEvery === 0;
    if (empty || failed) {
      mark = `${empty ? 'empty' : 'failed'}-${i}`;
      zone.onProgress({ tick: i, phase: empty ? 'empty' : 'failed', turns: ids });
      // An empty tick's words are dropped by the server and stay in the
      // stream; a failed tick's carry into the next tick.
      if (empty) clear(ids);
    } else {
      mark = `written-${i}`;
      note(i);
      zone.onProgress({ tick: i, phase: 'written', turns: ids });
      clear(ids);
      written++;
    }
    if (o.midSplit) {
      // A second split one beat into the last one's fade.
      await sleep(ms(300));
      mark = `midsplit-${i}`;
      await utter(5);
      const mid = unwritten.slice();
      zone.onProgress({ tick: 1000 + i, phase: 'composing', turns: mid });
      await sleep(ms(200));
      note(1000 + i);
      zone.onProgress({ tick: 1000 + i, phase: 'written', turns: mid });
      clear(mid);
      written++;
    }
    await sleep(ms(o.backToBack ? 120 : 1200));
  }
  await sleep(ms(1600));
  sampling = false;
  const stranded = document.querySelectorAll('.lz-lines .lz-turn').length;
  zone.destroy();
  const result: DriveResult = { samples, worst, written, stranded };
  return JSON.stringify(result);
}

/**
 * The scenario's own control: paint the pre-fix geometry on purpose and prove
 * the sampler can see it.
 *
 * A split whose words were not the front of the stream used to pull the stream
 * a whole line up with nothing to indent past — `--lz-hold-y` set, `--lz-hold-x`
 * zero. That is rebuilt here by hand, over a chunk that really is on screen, so
 * a run in which the sampler measured nothing fails HERE rather than passing
 * every assertion vacuously.
 */
async function control(): Promise<string> {
  const editor = document.getElementById('editor') as HTMLElement;
  const prose = document.querySelector('.ProseMirror') as HTMLElement;
  const zone = createMeetingLiveZone({ parent: editor, prose, reducedMotion: () => false });
  zone.begin(Date.now());
  zone.onTurn({ turn: 0, text: speech(14), final: true, speaker: 'A' });
  zone.onTurn({ turn: 1, text: speech(10), final: true, speaker: 'A' });
  zone.onProgress({ tick: 0, phase: 'composing', turns: [0] });
  const lines = document.querySelector('.lz-lines') as HTMLElement;
  const chunk = document.querySelector('.lz-chunk') as HTMLElement;
  // ONE line box, not the chunk's block height: at 430 the same words wrap to
  // two lines, and holding the stream up by the block would clear the tail
  // rather than land on it. The SHIFT is the line's advance and the reading is
  // the text's own box — 21px against 17px at 430 — so the shift lands the two
  // runs on each other rather than 4px apart.
  const range = document.createRange();
  range.selectNodeContents(chunk);
  const line = (range.getClientRects()[0] as DOMRect).height;
  const advance = Number.parseFloat(getComputedStyle(lines).lineHeight);
  lines.style.setProperty('--lz-hold-y', `${-advance}px`);
  lines.style.setProperty('--lz-hold-x', '0px');
  await new Promise((r) => requestAnimationFrame(r));
  const worst = worstOverlap();
  zone.destroy();
  return JSON.stringify({ worst, line });
}

declare global {
  interface Window {
    liveZoneDrive: (o: DriveOptions) => Promise<string>;
    liveZoneControl: () => Promise<string>;
  }
}
window.liveZoneDrive = drive;
window.liveZoneControl = control;
