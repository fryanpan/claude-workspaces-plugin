/**
 * A well-sourced research note, scrolled top to bottom, measured: where every
 * margin note is painted, and whether the sentence it belongs to is on screen.
 *
 * It mounts the REAL surface — a real editor, a real `mountReviewChrome`, and
 * `mountDocMargin`, which wires the footnote notes into the balloon column
 * exactly as the review page does — and then scrolls the pane the way a reader
 * does. Nothing here reads or asserts on source; it reports measured
 * rectangles.
 *
 * Fixture names are invented (Harborlight, Riverbend, Saltmarsh).
 */
import { type User, prose } from '@claude-workspaces/core';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { balloonMarginVisible } from '../src/card-placement.ts';
import { mountDocMargin } from '../src/doc/doc-margin.ts';
import { createEditor } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';
import { mountReviewChrome } from '../src/review-chrome.ts';
import {
  type CompactReading,
  type HoverReading,
  compactReading,
  hoverReading,
} from './footnote-margin-taps.ts';

/** See `ScrollReading.vanished`. */
const ROOM_PX = 60;

/** One margin note as painted, against the sentence it belongs to. */
interface NoteReading {
  n: string;
  /** Is any of the note painted inside the pane's visible box? */
  noteOnScreen: boolean;
  /** Is the note's own `^[…]` run inside the pane's visible box? */
  anchorOnScreen: boolean;
  top: number;
  bottom: number;
  anchorTop: number;
}

export interface ScrollReading {
  scrollTop: number;
  /** The pane's visible box, in viewport px. */
  paneTop: number;
  paneBottom: number;
  /** Notes whose anchor is on screen and whose card is not. */
  missing: string[];
  /** …of those, the ones whose line has `ROOM_PX` of pane below it — the
   *  vanishing. A note in a stack is pushed down by the notes above it, so
   *  one whose line is the last sliver of the pane may sit just under it. */
  vanished: string[];
  /** Pairs of on-screen notes whose boxes intersect — the bunching. */
  overlaps: Array<[string, string, number]>;
  /** Notes beside an on-screen anchor — the control for both counts. */
  beside: number;
}

export interface FootnoteProbe {
  marginVisible: boolean;
  /** Notes the doc holds, and margin cards found for them. */
  notes: number;
  cards: number;
  /** Runs whose superscript number is drawn — every one, at every width. */
  superscripts: number;
  /** Notes whose card starts with the number drawn at their run. */
  paired: number;
  /** What the phone's popover starts with after a tap on note 3. */
  popNumber: string | null;
  /** How far the first run's number is raised: the gap between the bottom of
   *  its painted box and the bottom of the letter before it, as a share of
   *  that letter's height. A number sitting on the baseline reads near 0.15. */
  lift: number | null;
  /** The number's colour against its paragraph's, as computed. */
  numberColour: string;
  textColour: string;
  scrollHeight: number;
  clientHeight: number;
  /** Read every few frames during one continuous gesture, top to foot and
   *  back, a few px a frame — the column's debounce never fires mid-gesture,
   *  which is what a flick on an iPad is. */
  scrolling: ScrollReading[];
  /** After the column has had its debounce at each step. */
  settled: ScrollReading[];
  /** The pointer passing over the body text and its superscripts. */
  hover: HoverReading;
  /** The one-line captions and the taps that open them; null without a
   *  margin. */
  compact: CompactReading | null;
  /** The phone popover's height after the tap on note 3, against its own
   *  line height — the note is still drawn in full there. */
  popHeight: number | null;
  popLineHeight: number | null;
}

/** A source note in the shape the research notes carry: a link, a page range
 *  and a backticked provenance tag. Long on purpose — three or four lines in
 *  the margin column, which is what a real citation runs to. */
function note(i: number): string {
  const place = ['Harborlight', 'Riverbend', 'Saltmarsh'][i % 3] as string;
  return (
    `^[${place} Safe Routes, [2024-25 Annual Report](https://www.example.org/${place.toLowerCase()}.pdf), ` +
    `pp. ${40 + i}-${41 + i}. \`[primary — read 2026-09-30]\`]`
  );
}

const FILL =
  'The crossing guards counted walkers at each school gate twice a term and the totals were ' +
  'compared against the enrolment figures the district publishes each autumn';

/** About twenty paragraphs, a note on most, a few short ones close together,
 *  three tables and three bullet lists. */
export function fixtureMarkdown(): string {
  const out: string[] = ['# Harborlight walking audit'];
  let n = 0;
  for (let i = 0; i < 20; i++) {
    // Short paragraphs in a run: their anchors are a line apart, so their
    // notes cannot all sit beside them and must stack.
    const short = i >= 5 && i <= 8;
    const body = short ? `Gate ${i} counted ${30 + i} walkers.` : `Paragraph ${i}: ${FILL}.`;
    out.push(i % 6 === 3 ? body : `${body}${note(n++)}`);
    if (i === 4 || i === 11 || i === 17) {
      out.push(
        [
          '| School | Walkers | Share |',
          '| --- | --- | --- |',
          '| Harborlight | 120 | 31% |',
          '| Riverbend | 96 | 24% |',
          '| Saltmarsh | 88 | 22% |',
        ].join('\n'),
      );
      out.push(
        [
          `- Alice counted the north gate.${note(n++)}`,
          `- Bob counted the south gate.${note(n++)}`,
          '- Nobody counted the east gate.',
        ].join('\n'),
      );
    }
  }
  return out.join('\n\n');
}

const USER: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };

const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function read(editorEl: HTMLElement, proseEl: HTMLElement): ScrollReading {
  const pane = editorEl.getBoundingClientRect();
  const top = pane.top;
  const bottom = pane.top + editorEl.clientHeight;
  const per: NoteReading[] = [];
  const seen = new Set<string>();
  for (const a of proseEl.querySelectorAll<HTMLElement>('.cw-fn[data-cw-fn]')) {
    const n = a.dataset.cwFn ?? '';
    if (seen.has(n)) continue;
    seen.add(n);
    const ar = a.getBoundingClientRect();
    // The margin card is the `.cw-fn-note` the column placed for this number.
    const card = [...document.querySelectorAll<HTMLElement>('.markup-margin .cw-fn-note')].find(
      (el) => el.dataset.cwFnN === n,
    );
    const cr = card?.getBoundingClientRect();
    const painted =
      card !== undefined &&
      cr !== undefined &&
      getComputedStyle(card).display !== 'none' &&
      cr.height > 0 &&
      cr.bottom > top &&
      cr.top < bottom;
    per.push({
      n,
      noteOnScreen: painted,
      anchorOnScreen: ar.bottom > top && ar.top < bottom,
      top: cr?.top ?? Number.NaN,
      bottom: cr?.bottom ?? Number.NaN,
      anchorTop: ar.top,
    });
  }
  const shown = per.filter((p) => p.noteOnScreen);
  const overlaps: Array<[string, string, number]> = [];
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i] as NoteReading;
      const b = shown[j] as NoteReading;
      const o = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (o > 0.5) overlaps.push([a.n, b.n, Math.round(o)]);
    }
  }
  return {
    scrollTop: editorEl.scrollTop,
    paneTop: top,
    paneBottom: bottom,
    missing: per.filter((p) => p.anchorOnScreen && !p.noteOnScreen).map((p) => p.n),
    vanished: per
      .filter((p) => p.anchorOnScreen && p.anchorTop < bottom - ROOM_PX && !p.noteOnScreen)
      .map((p) => p.n),
    overlaps,
    beside: per.filter((p) => p.anchorOnScreen && p.noteOnScreen).length,
  };
}

/** How long the column may take to restack once the pane has stopped. */
const RESTACK_MS = 5_000;

/**
 * Move the pane and wait for the column to stack against the new position.
 * It restacks 100ms after a scroll stops and redraws every leader line when
 * it does, so the overlay's children changing is the restack. Nothing moves
 * on a move to where the pane already is, and no column is drawn at 430.
 */
async function scrollAndRestack(editorEl: HTMLElement, y: number): Promise<void> {
  let passes = 0;
  const seen = new MutationObserver(() => {
    passes += 1;
  });
  seen.observe(document.querySelector('.cw-leader-overlay') as Element, { childList: true });
  const from = editorEl.scrollTop;
  editorEl.scrollTop = y;
  const end = performance.now() + RESTACK_MS;
  while (balloonMarginVisible() && editorEl.scrollTop !== from && passes === 0) {
    if (performance.now() > end) throw new Error(`no restack after a scroll to ${y}`);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
  seen.disconnect();
  await frame();
}

/** The fixture, mounted as the review page mounts it, and nothing measured. */
async function mountFixture(): Promise<{
  editorEl: HTMLElement;
  editor: ReturnType<typeof createEditor>;
}> {
  const editorEl = document.getElementById('editor') as HTMLElement;
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(fixtureMarkdown()));
  const editor = createEditor({ parent: editorEl, ydoc, awareness: new Awareness(ydoc) });
  const scope = new MountScope();
  const chrome = mountReviewChrome({
    docId: 'd1',
    user: USER,
    ydoc,
    surface: editor,
    whenSynced: (cb) => cb(),
    canWrite: true,
    scope,
    selectHint: '',
    reanchorHint: '',
    getSelection: () => editor.getSelectionRel(),
  });
  mountDocMargin({ docId: 'd1', ydoc, scope, editor, editorMount: editorEl, chrome });
  await frame();
  await sleep(300);
  await frame();
  return { editorEl, editor };
}

async function probe(): Promise<string> {
  const { editorEl, editor } = await mountFixture();

  // Each card carries the number of the run it belongs to, which is how a
  // reading pairs the two.
  const proseEl = editor.editor.view.dom;
  const cards = [...document.querySelectorAll<HTMLElement>('.markup-margin .cw-fn-note')];
  const runs = [...proseEl.querySelectorAll<HTMLElement>('.cw-fn[data-cw-fn]')];
  const notes = new Set(runs.map((r) => r.dataset.cwFn));
  const drawn = (el: Element, pseudo: string) => getComputedStyle(el, pseudo).content;
  // A note is paired when the number drawn at its run is the number drawn at
  // the start of its card — the reader's way of telling which is which.
  const paired = [...notes].filter((n) => {
    const card = cards.find((c) => c.dataset.cwFnN === n);
    const run = runs.find((r) => r.dataset.cwFn === n);
    return (
      card && run && drawn(card, '::before') === `"${n}"` && drawn(run, '::after') === `"${n}"`
    );
  }).length;

  const first = runs[0] as HTMLElement;
  first.scrollIntoView({ block: 'center' });
  await frame();
  const lift = numberLift(first);
  const numberColour = getComputedStyle(first, '::after').color;
  const textColour = getComputedStyle(first.parentElement as HTMLElement).color;

  const hover = await hoverReading(editor);

  const max = editorEl.scrollHeight - editorEl.clientHeight;
  const hold = (window as { footnoteHold?: string }).footnoteHold;
  if (hold === 'gesture') {
    // Leave the pane MID-GESTURE for the screenshot: still moving, a pixel a
    // frame, so the column's debounce has not fired when the capture lands.
    editorEl.scrollTop = 0;
    await sleep(250);
    await frame();
    const to = Math.round(max * 0.3);
    while (editorEl.scrollTop < to) {
      editorEl.scrollTop += 9;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    // …and keep it moving after this returns, so the capture lands mid-flick.
    let tick = 0;
    const keep = setInterval(() => {
      editorEl.scrollTop += 3;
      if (++tick > 200) clearInterval(keep);
    }, 16);
    return JSON.stringify({ hold: read(editorEl, proseEl) });
  }
  const scrolling: ScrollReading[] = [];
  const settled: ScrollReading[] = [];
  // One gesture, down and back, 12px a frame, read every sixth frame.
  const path: number[] = [];
  for (let y = 0; y <= max; y += 12) path.push(y);
  path.push(max);
  for (let y = max; y >= 0; y -= 12) path.push(y);
  for (const [i, y] of path.entries()) {
    editorEl.scrollTop = y;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (i % 6 === 0) scrolling.push(read(editorEl, proseEl));
  }
  // Then at rest: step through the doc, letting the column settle at each stop.
  const step = Math.max(80, Math.round(editorEl.clientHeight / 4));
  const stops: number[] = [];
  for (let y = 0; y < max; y += step) stops.push(y);
  stops.push(max);
  for (const y of [...stops, ...stops.slice(0, -1).reverse()]) {
    await scrollAndRestack(editorEl, y);
    settled.push(read(editorEl, proseEl));
  }
  // Leave the pane part-way down, settled, for the screenshot.
  editorEl.scrollTop = Math.round(max * 0.4);
  await frame();
  await sleep(250);
  await frame();

  const compact = balloonMarginVisible() ? await compactReading(cards) : null;

  // Where there is no margin, the tapped number opens a card that starts with
  // the same number. Tap the third, and leave it open for the screenshot.
  let popNumber: string | null = null;
  let popHeight: number | null = null;
  let popLineHeight: number | null = null;
  const third = runs.find((r) => r.dataset.cwFn === '3');
  if (!balloonMarginVisible() && third) {
    third.scrollIntoView({ block: 'center' });
    await frame();
    third.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await frame();
    const pop = document.querySelector<HTMLElement>('.cw-fn-pop');
    popNumber = pop ? drawn(pop, '::before') : null;
    popHeight = pop?.offsetHeight ?? null;
    popLineHeight = pop ? Number.parseFloat(getComputedStyle(pop).lineHeight) : null;
  }

  const out: FootnoteProbe = {
    marginVisible: balloonMarginVisible(),
    paired,
    popNumber,
    lift,
    numberColour,
    textColour,
    notes: notes.size,
    cards: cards.length,
    superscripts: runs.filter((r) => getComputedStyle(r, '::after').display !== 'none').length,
    scrollHeight: editorEl.scrollHeight,
    clientHeight: editorEl.clientHeight,
    scrolling,
    settled,
    compact,
    hover,
    popHeight,
    popLineHeight,
  };
  return JSON.stringify(out);
}

/** A pseudo-element has no box of its own to ask for, but a hit on its paint
 *  reports its element — so walk a column down through the number and keep
 *  the rows that land on the run. Measured against the letter just before the
 *  run, whose box a Range gives. */
function numberLift(run: HTMLElement): number | null {
  // The last text before the run in its paragraph — the fact it supports is
  // usually wrapped in a span of its own, so not simply the previous sibling.
  const block = run.closest('p, li, td, h1, h2, h3') ?? run.parentElement;
  if (!block) return null;
  const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let prev: Text | null = null;
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    if (run.contains(t)) break;
    if ((t as Text).length >= 2) prev = t as Text;
  }
  if (!prev) return null;
  const range = document.createRange();
  range.setStart(prev, prev.length - 2);
  range.setEnd(prev, prev.length - 1);
  const letter = range.getBoundingClientRect();
  const box = run.getBoundingClientRect();
  const x = box.left + box.width / 2;
  let bottom: number | null = null;
  for (let y = letter.top - 15; y < letter.bottom + 5; y += 0.5) {
    if (document.elementFromPoint(x, y) === run) bottom = y;
  }
  if (bottom === null || letter.height === 0) return null;
  return (letter.bottom - bottom) / letter.height;
}

declare global {
  interface Window {
    footnoteMarginProbe: () => Promise<string>;
    footnoteMarginMount: () => Promise<void>;
  }
}
window.footnoteMarginProbe = probe;
window.footnoteMarginMount = async () => {
  await mountFixture();
};
