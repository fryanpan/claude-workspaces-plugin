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
  /**
   * Leave two ticks outstanding: fire the next tick's `composing` before this
   * one's outcome comes back. The server does this whenever a tick fires while
   * another is still composing — it announces `composing` per FIRING and
   * reports the outcome per COMPOSE — so the client sees the frames in this
   * order for real.
   */
  interleave: boolean;
  /** Leave no quiet gap between one write and the next. */
  backToBack: boolean;
  /**
   * How many people are speaking. Two or more is a different rendering path,
   * not a variation on one: the zone only draws a speaker pill once it has
   * heard a second voice, and a pill is an inline element inside the turn's
   * own span — it changes where every line after it breaks. A measurement
   * taken with one voice cannot see a smear that needs a pill to happen.
   */
  voices: number;
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
  /**
   * Samples in which two or more runs of text were on screen, so a comparison
   * was actually possible. This, not `samples`, is what makes a reading of
   * zero mean something: a sampler that found one run every time would report
   * a clean meeting however hard it looked.
   */
  compared: number;
  /** The worst overlap seen across the whole meeting. */
  worst: Overlap;
  /** Note-writes that actually reported `written`. */
  written: number;
  /**
   * Turns an `empty` tick handed back to the stream, which the server's carry
   * then dropped — so no later tick ever names them again and they sit at the
   * head of the stream for the rest of the meeting. This is the state the
   * smear needs, counted from the frames driven rather than from the DOM: a
   * count of what is on screen is every streaming turn and proves nothing.
   */
  stranded: number;
  /** Turns left in the stream at the end, stranded ones included. */
  streaming: number;
  /**
   * The most speaker pills on screen in any one sample. Zero from a run that
   * asked for two voices means the pill path never rendered and the reading
   * below is about a stream that never grew one.
   */
  pills: number;
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
 *
 * It stops at the zone. The page never scrolls itself to the transcript
 * (owner, 2026-09-11: "Never follow"), so the zone spends most of a long
 * meeting below the fold, and the scroll pane's clip would hide every run
 * there — a clean zero measured over nothing. Two runs drawn over each other
 * are a smear wherever the reader has scrolled to.
 */
function clipOf(el: Element | null): Box | null {
  let box: Box | null = null;
  const stop = el?.closest('.live-zone')?.parentElement ?? document.body;
  for (let n = el; n && n !== stop; n = n.parentElement) {
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

/**
 * Every run the zone is painting, tagged PER TURN.
 *
 * Not per container. The whole of the fix is that a settle which cannot lift
 * happens INSIDE `.lz-lines`, so a tag per container would give every run in
 * the stream one source and make the pair-skipping rule below throw away the
 * very overlap this file exists to catch — the post-fix zero would be a zero
 * because nothing was compared. A turn is the smallest thing the layout moves
 * as a unit, so it is the right grain: two rects of ONE turn are the browser
 * wrapping a line, and two rects of two turns intersecting is a smear whether
 * they sit in one box or two.
 */
function painted(): Painted[] {
  const out: Painted[] = [];
  const zone = document.querySelector('.live-zone');
  if (!zone) return out;
  let i = 0;
  for (const turn of zone.querySelectorAll('.lz-turn')) glyphRects(turn, `turn${i++}`, out);
  return out;
}

/**
 * The worst intersection between two runs of text that are not the same run.
 *
 * The settle deliberately leaves the stream's first line on the same LINE as
 * the chunk's tail — beside it, past the indent — so adjacency is expected and
 * only intersected area is a smear.
 */
export function worstOverlap(runs: readonly Painted[] = painted()): Overlap {
  const rs = [...runs].sort((a, b) => a.top - b.top);
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

/** `n` words from a FIXED point in the run — the same text however far the
 *  meeting's own cursor has walked, which is what a built scenario needs. */
function speechFrom(at: number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[(at + i) % WORDS.length] as string);
  return out.join(' ');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Put both halves of the settle's clock on one scale.
 *
 * Installed from the ORIGINAL timer and into ONE style element every time, so
 * a page that drives several meetings scales each of them by the factor it
 * asked for rather than by the product of every factor before it.
 */
const realTimeout = window.setTimeout;
const scaleSheet = document.createElement('style');
document.head.append(scaleSheet);
function scaleClock(scale: number): void {
  // biome-ignore lint/suspicious/noExplicitAny: the timer's own signature
  window.setTimeout = ((fn: any, delay?: number, ...rest: any[]) =>
    realTimeout(fn, Math.max(0, Math.round((delay ?? 0) * scale)), ...rest)) as typeof setTimeout;
  scaleSheet.textContent = `.live-zone{--lz-fade-ms:${Math.round(260 * scale)}ms;--lz-collapse-ms:${Math.round(440 * scale)}ms}`;
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
  scaleClock(o.scale);

  const zone = createMeetingLiveZone({ parent: editor, prose, reducedMotion: () => false });
  zone.begin(Date.now());

  let samples = 0;
  let compared = 0;
  let pills = 0;
  let sampling = true;
  let mark = 'start';
  let worst: Overlap = { area: 0, width: 0, height: 0 };
  const sample = (): void => {
    if (!sampling) return;
    samples++;
    const runs = painted();
    if (runs.length >= 2) compared++;
    pills = Math.max(pills, document.querySelectorAll('.lz-speaker').length);
    const w = worstOverlap(runs);
    if (w.area > worst.area) worst = { ...w, mark };
  };
  /**
   * Every moment the zone is asked to change, sampled synchronously — the
   * animation frames BETWEEN them are covered by the loop below, but they are
   * the half a loaded machine takes away. Chrome throttles `requestAnimation
   * Frame` hard under a full test suite: the same meeting that samples ~800
   * frames idle sampled 32 inside `bun run verify`, which turned the guard
   * against a blind sampler into a guard against a busy machine.
   */
  const at = (m: string): void => {
    mark = m;
    sample();
  };
  const frame = (): void => {
    if (!sampling) return;
    sample();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  let nextId = 0;
  let unwritten: number[] = [];
  let written = 0;
  let stranded = 0;

  /** One utterance: partial, partial, final — under one id, as the engine does. */
  async function utter(words: number): Promise<void> {
    const id = nextId++;
    // A new voice every utterance where the meeting has more than one, which
    // is what puts a pill on the front of nearly every turn.
    const speaker = String.fromCharCode(65 + (id % Math.max(1, o.voices)));
    zone.onTurn({ turn: id, text: speech(2), final: false, speaker });
    await sleep(ms(60));
    zone.onTurn({ turn: id, text: speech(words), final: false, speaker });
    await sleep(ms(60));
    zone.onTurn({ turn: id, text: speech(2), final: true, speaker });
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
    at(`speaking-${i}`);
    await utter(7);
    await utter(6);
    const ids = unwritten.slice();
    at(`composing-${i}`);
    zone.onProgress({ tick: i, phase: 'composing', turns: ids });
    sample();
    // Words keep arriving while the tick composes.
    await utter(5);
    await sleep(ms(120));
    // A second tick fires while this one is still composing. Its own outcome
    // is reported after this one's, which is the ordering that made a
    // remembered answer from the first go stale inside the second.
    let outstanding: number[] = [];
    if (o.interleave) {
      at(`outstanding-${i}`);
      await utter(4);
      outstanding = unwritten.filter((id) => !ids.includes(id));
      if (outstanding.length > 0) {
        zone.onProgress({ tick: 2000 + i, phase: 'composing', turns: outstanding });
        sample();
      }
    }
    const empty = o.emptyEvery > 0 && (i + 1) % o.emptyEvery === 0;
    const failed = !empty && o.failEvery > 0 && (i + 1) % o.failEvery === 0;
    if (empty || failed) {
      at(`${empty ? 'empty' : 'failed'}-${i}`);
      zone.onProgress({ tick: i, phase: empty ? 'empty' : 'failed', turns: ids });
      sample();
      // An empty tick's words are dropped by the server and stay in the
      // stream; a failed tick's carry into the next tick.
      if (empty) {
        clear(ids);
        stranded += ids.length;
      }
    } else {
      at(`written-${i}`);
      note(i);
      zone.onProgress({ tick: i, phase: 'written', turns: ids });
      sample();
      clear(ids);
      written++;
    }
    if (outstanding.length > 0) {
      at(`outstanding-written-${i}`);
      note(2000 + i);
      zone.onProgress({ tick: 2000 + i, phase: 'written', turns: outstanding });
      sample();
      clear(outstanding);
      written++;
    }
    if (o.midSplit) {
      // A second split one beat into the last one's fade.
      await sleep(ms(300));
      at(`midsplit-${i}`);
      await utter(5);
      const mid = unwritten.slice();
      zone.onProgress({ tick: 1000 + i, phase: 'composing', turns: mid });
      sample();
      await sleep(ms(200));
      note(1000 + i);
      zone.onProgress({ tick: 1000 + i, phase: 'written', turns: mid });
      sample();
      clear(mid);
      written++;
    }
    await sleep(ms(o.backToBack ? 120 : 1200));
  }
  await sleep(ms(1600));
  sampling = false;
  const streaming = document.querySelectorAll('.lz-lines .lz-turn').length;
  zone.destroy();
  const result: DriveResult = { samples, compared, worst, written, stranded, streaming, pills };
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
  scaleClock(1);
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

/** One chunk's box, beside the floated label, under one `overflow` value. */
export interface ClipBox {
  width: number;
  height: number;
  top: number;
}

export interface ClipReading {
  /** The rule as it ships: `.lz-slot { overflow: clip }`. */
  clip: ClipBox;
  /** The same slot forced back to `visible` — no clip at all. */
  visible: ClipBox;
  /** The same slot as `hidden`, which is what `clip` is here instead of. */
  hidden: ClipBox;
}

/**
 * WHY THE SLOT SAYS `clip` AND NOT `hidden`, measured rather than asserted.
 *
 * Both stop the paint. Only `hidden` makes the slot a block formatting
 * context, and a BFC refuses to sit beside `.lz-head`'s float: the box is
 * narrowed to clear the label, so the chunk's words re-wrap and MOVE on the
 * one frame the split promises nothing moves on. `clip` is not a scroll
 * container, establishes no BFC, and changes no layout at all.
 *
 * So this reads one chunk's box beside the float under all three values. The
 * test's job is that `clip` matches `visible` to the pixel while `hidden`
 * does not — the second half being the control: without it, a reading in
 * which the float had no effect at all would pass the first half vacuously.
 */
async function clipControl(): Promise<string> {
  scaleClock(1);
  const editor = document.getElementById('editor') as HTMLElement;
  const prose = document.querySelector('.ProseMirror') as HTMLElement;
  const zone = createMeetingLiveZone({ parent: editor, prose, reducedMotion: () => false });
  zone.begin(Date.now());
  // Enough words that a line short by the label's width has to break again.
  zone.onTurn({ turn: 0, text: speech(12), final: true, speaker: 'A' });
  zone.onProgress({ tick: 0, phase: 'composing', turns: [0] });
  const slot = document.querySelector('.lz-slot') as HTMLElement;
  const chunk = document.querySelector('.lz-chunk') as HTMLElement;
  const boxOf = async (overflow: string): Promise<ClipBox> => {
    slot.style.overflow = overflow;
    await new Promise((r) => requestAnimationFrame(r));
    const b = chunk.getBoundingClientRect();
    return { width: b.width, height: b.height, top: b.top };
  };
  const reading: ClipReading = {
    // '' first is not a saving: each reading sets the property it needs.
    clip: await boxOf('clip'),
    visible: await boxOf('visible'),
    hidden: await boxOf('hidden'),
  };
  slot.style.removeProperty('overflow');
  zone.destroy();
  return JSON.stringify(reading);
}

export interface RewrapReading {
  /** The label's width — what the top line of the zone is short by. */
  label: number;
  /** Words chosen so they fill one full-width line and overflow a short one. */
  words: number;
  /** The settling chunk's own height once it has ridden up beside the label. */
  chunkH: number;
  /** The height its slot was pinned to, back when it sat below the label. */
  slotH: number;
  /** What is painted on top of what, with the chunk in that state. */
  worst: Overlap;
}

/**
 * THE SMEAR'S OWN MECHANISM, BUILT ON PURPOSE.
 *
 * The meeting arms above reach this state by luck: whether a chunk's last
 * line ends within a label's width of the right edge depends on which words
 * the transcript happened to be up to, so the same scenario smeared on CI's
 * fonts and measured a flat zero on a Mac. That is not a test of anything.
 *
 * So this builds it. A chunk is settled BELOW the label, where its words fit
 * one line and its slot is pinned to hold exactly that; the chunk above it is
 * then collapsed to nothing, which is what slides it up into the corner where
 * `.lz-head`'s float shortens its top line and the same words need two. Its
 * slot still promises one — growing it would step every word below it down a
 * line mid-collapse — so the second line is outside the box that holds it,
 * and `.lz-slot { overflow: clip }` is the whole of what stops it being drawn
 * over the chunk below. Remove that declaration and this reads a full line of
 * one opaque run over another.
 *
 * `chunkH` against `slotH` is the control: it says the overflow was really
 * built. Without it a run in which the words happened not to re-wrap would
 * report the same clean zero as a run in which the clip did its job.
 */
async function rewrapControl(): Promise<string> {
  scaleClock(1);
  const editor = document.getElementById('editor') as HTMLElement;
  const prose = document.querySelector('.ProseMirror') as HTMLElement;
  const zone = createMeetingLiveZone({ parent: editor, prose, reducedMotion: () => false });
  zone.begin(Date.now());
  const root = document.querySelector('.live-zone') as HTMLElement;
  // The zone hides itself while it holds nothing, and a hidden box measures
  // zero — so the words it is about to carry go in before anything is read.
  zone.onTurn({ turn: 0, text: speech(6), final: true, speaker: 'A' });
  zone.onTurn({ turn: 2, text: speech(8), final: true, speaker: 'A' });
  const label = (document.querySelector('.lz-head') as HTMLElement).getBoundingClientRect().width;

  // How many words fill one line at full width but not at a line short by the
  // label — measured on a scratch block of the stream's own type, because the
  // answer is a font metric and differs on every platform this runs on.
  const scratch = document.createElement('div');
  scratch.className = 'lz-chunk-lines';
  root.append(scratch);
  const linesOf = (n: number, width: number): number => {
    scratch.style.width = `${width}px`;
    scratch.textContent = speechFrom(0, n);
    const r = document.createRange();
    r.selectNodeContents(scratch);
    return r.getClientRects().length;
  };
  const full = root.getBoundingClientRect().width;
  let words = 0;
  for (let n = 2; n < 60; n++) {
    if (linesOf(n, full) === 1 && linesOf(n, full - label) > 1) {
      words = n;
      break;
    }
  }
  scratch.remove();
  if (words === 0) {
    return JSON.stringify({
      label,
      words,
      chunkH: 0,
      slotH: 0,
      worst: { area: 0, width: 0, height: 0 },
    });
  }

  // Three chunks and no live stream: the smear is one settling chunk drawn
  // over the next, and a stream left in the zone would bring the hold with it
  // — a second mechanism, with its own bug, measured by the arms above.
  // Turn 0's chunk is the one that collapses, turn 1's is the one that rides
  // up into its place, turn 2's is what its extra line would be drawn over.
  zone.onTurn({ turn: 1, text: speechFrom(0, words), final: true, speaker: 'A' });
  for (const id of [0, 1, 2]) {
    zone.onProgress({ tick: id, phase: 'composing', turns: [id] });
    // Turn 1's pin is taken here, below the label, at the one line it needs
    // there.
    zone.onProgress({ tick: id, phase: 'written', turns: [id] });
  }
  await new Promise((r) => requestAnimationFrame(r));

  // Where the collapse of the chunk above ENDS: `discard` takes its slot out
  // of the zone. The end state and not the travel, so this arm waits on no
  // animation — and so the only thing left that could paint outside a slot is
  // the re-wrap it is about.
  const slots = document.querySelectorAll('.lz-slot');
  (slots[0] as HTMLElement).remove();
  await new Promise((r) => requestAnimationFrame(r));

  const slot = slots[1] as HTMLElement;
  const chunk = slot.firstElementChild as HTMLElement;
  const reading: RewrapReading = {
    label,
    words,
    chunkH: chunk.getBoundingClientRect().height,
    slotH: slot.getBoundingClientRect().height,
    worst: worstOverlap(),
  };
  zone.destroy();
  return JSON.stringify(reading);
}

export interface TapReading {
  /** The speaker button really rendered, and really hangs past its line. */
  overhang: number;
  /** Does a tap in that overhang reach the button while the slot is unpinned
   *  — the whole of the compose, which is the part of a chunk's life somebody
   *  reads and taps a name in? */
  unpinned: boolean;
  /** And once `settle` has pinned the slot and the clip is on. Documented
   *  rather than demanded: from here the chunk is fading out. */
  pinned: boolean;
}

/**
 * WHAT THE CLIP COSTS, AND WHERE IT IS NOT ALLOWED TO COST IT.
 *
 * `overflow: clip` clips hit-testing as well as paint, and `.lz-speaker` is a
 * tap target built out of 8px of padding above and below its line, cancelled
 * by negative margins so the line never grows for it. Inside a slot that is
 * the part of the target that hangs outside the box.
 *
 * So the clip is on `.is-pinned` and not on `.lz-slot`: a chunk is unpinned
 * for the whole of its compose — the long, readable part of its life — and
 * pinned only for the fade and the collapse that take it away. This drives a
 * real tap at the top of that overhang and reports which of the two states
 * answers it. `overhang` is the control: zero would mean no button rendered
 * and both readings below would be about nothing.
 */
async function tapControl(): Promise<string> {
  scaleClock(1);
  const editor = document.getElementById('editor') as HTMLElement;
  const prose = document.querySelector('.ProseMirror') as HTMLElement;
  const zone = createMeetingLiveZone({
    parent: editor,
    prose,
    reducedMotion: () => false,
    // Only a zone that can record a name renders the button; a span would have
    // no tap target to lose.
    nameSpeaker: () => {},
  });
  zone.begin(Date.now());
  // Two voices, or the zone draws no pill at all.
  zone.onTurn({ turn: 0, text: speechFrom(0, 4), final: true, speaker: 'A' });
  zone.onTurn({ turn: 1, text: speechFrom(8, 4), final: true, speaker: 'B' });
  zone.onProgress({ tick: 0, phase: 'composing', turns: [0, 1] });
  await new Promise((r) => requestAnimationFrame(r));
  const slot = document.querySelector('.lz-slot') as HTMLElement;
  const button = slot.querySelector('.lz-speaker') as HTMLElement;
  const b = button.getBoundingClientRect();
  const overhang = slot.getBoundingClientRect().top - b.top;
  // A real tap, in the overhang, on the button's own column.
  const x = b.left + Math.min(6, b.width / 2);
  const y = b.top + 1;
  const hits = (): boolean => {
    const el = document.elementFromPoint(x, y);
    return el !== null && (el === button || button.contains(el));
  };
  const unpinned = hits();
  // What `settle` does, without waiting out its beats.
  slot.style.height = `${slot.getBoundingClientRect().height}px`;
  slot.classList.add('is-pinned');
  await new Promise((r) => requestAnimationFrame(r));
  const reading: TapReading = { overhang, unpinned, pinned: hits() };
  zone.destroy();
  return JSON.stringify(reading);
}

declare global {
  interface Window {
    liveZoneTap: () => Promise<string>;
    liveZoneDrive: (o: DriveOptions) => Promise<string>;
    liveZoneRewrap: () => Promise<string>;
    liveZoneControl: () => Promise<string>;
    liveZoneClipControl: () => Promise<string>;
  }
}
window.liveZoneDrive = drive;
window.liveZoneTap = tapControl;
window.liveZoneRewrap = rewrapControl;
window.liveZoneControl = control;
window.liveZoneClipControl = clipControl;
