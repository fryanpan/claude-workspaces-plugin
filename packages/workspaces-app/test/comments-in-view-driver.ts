/**
 * A meeting running over a commented doc, measured: where every comment card
 * actually sits, and whether the text it marks is on screen.
 *
 * It mounts the REAL surface — a real editor, a real `mountReviewChrome`, the
 * real balloon column and the real off-screen hints — and then runs the real
 * live zone at the foot of it, pumping transcript turns the way the engine
 * does. Nothing here reads or asserts on source: it drives the modules and
 * reports measured rectangles, which is what testing standard 1 asks of a
 * layout check.
 *
 * WHY A BROWSER. Every question this file asks is a used-geometry question —
 * which rect is inside which — and happy-dom lays nothing out (`css-harness.ts`
 * says so in full). The declarations involved read identically before and
 * after the fix.
 *
 * The fixture's names are invented (Riverbend, Harborlight); nothing here
 * quotes a real meeting.
 */
import { type User, createThread, prose } from '@claude-workspaces/core';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { balloonMarginVisible, cardPlacement } from '../src/card-placement.ts';
import { mountCommentHints, tallyTotal } from '../src/comment-hints.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { createMeetingLiveZone } from '../src/meeting-live-zone.ts';
import { MountScope } from '../src/mount-scope.ts';
import { mountMarkupMargin } from '../src/redline/markup-margin.ts';
import { type ReviewChrome, mountReviewChrome } from '../src/review-chrome.ts';
import { threadCards } from '../src/thread-morph.ts';

/** One comment card as it is painted, beside the text it marks. */
export interface CardReading {
  id: string;
  /** Is any part of the card painted inside the pane's visible box? */
  cardOnScreen: boolean;
  /** Is any part of its highlight inside the pane's visible box? */
  anchorOnScreen: boolean;
  /** Card top minus anchor top, in viewport px. Only meaningful when both
   *  are on screen. */
  offsetFromAnchor: number;
  /** The card's own box, for the report. */
  cardTop: number;
  cardBottom: number;
  anchorTop: number;
  anchorBottom: number;
}

export interface Reading {
  /** Which comment surface this width resolved to — `balloon` is the only
   *  one with a margin, so a reading of `inline` says the margin criterion
   *  does not apply here and the reachability one does. */
  placement: string;
  marginVisible: boolean;
  /** Threads created. Zero would make every count below vacuous. */
  threads: number;
  /** Cards found in the DOM. Zero is the same vacuity, one layer down. */
  cards: number;
  /** The pane's visible box, for the report. */
  paneTop: number;
  paneBottom: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** The top strip's reserved band — the thing that used to drag the stack. */
  bandTop: number;
  bandBottom: number;
  /** Is any of the live transcript on screen? */
  zoneOnScreen: boolean;
  zoneHeight: number;
  /** Cards painted on screen whose own text is NOT — the fault, counted. */
  detached: number;
  /** The worst such card's distance from its text, in px. Zero when none. */
  worstDetachment: number;
  /** Cards painted on screen beside text that IS on screen — the positive
   *  control for the count above: a column that rendered nothing at all would
   *  report zero detached cards and mean nothing by it. */
  beside: number;
  per: CardReading[];
}

export interface Probe {
  /** The reader has scrolled down to watch the transcript at the foot, every
   *  comment far above. */
  watching: Reading;
  /** The reader scrolls up to one comment's own text, then the transcript
   *  keeps growing. Does the comment stay beside its text? */
  afterScrollBack: Reading;
  /** The thread the reader scrolled to in `afterScrollBack`. */
  target: string;
  /** The jump the "N above" pill makes, taken while the meeting runs. */
  jumped: JumpReading;
  /** The reader parked on a comment MID-doc while the meeting runs on. */
  held: HeldReading;
  /** The reader at the top while the transcript grows past the fold. */
  untouched: UntouchedReading;
  /** A tall card whose text just left the top of a short scroll. */
  clamped: ClampedReading;
  /** Notes landing above the reader's comments, read one frame later. */
  landed: LandedReading;
}

/** Reaching a comment from the strip, with the transcript still growing. */
export interface JumpReading {
  /** The reader was at the foot, watching the transcript, before the jump. */
  watchingBefore: boolean;
  /** …and not one comment's text was on screen then. */
  anchorsOnScreenBefore: number;
  /** `revealThreadBalloon` found a card to reveal. */
  revealed: boolean;
  /** After the jump: is the jumped thread's own text on screen? */
  anchorOnScreen: boolean;
  /** …and its card, beside it? */
  cardOnScreen: boolean;
  offsetFromAnchor: number;
}

/** Does the reader's line stay put while the meeting writes under it? */
export interface HeldReading {
  /** The anchor's viewport top when the reader stopped there. */
  anchorTop0: number;
  /** …and after eight notes landed and the transcript grew. */
  anchorTop1: number;
  /** Its card's viewport top at the same two moments. */
  cardTop0: number;
  cardTop1: number;
  /** The pane's scroll offset at the two moments — the page moving. */
  scrollTop0: number;
  scrollTop1: number;
  /** Proof the meeting really ran under the reader. */
  scrollHeight0: number;
  scrollHeight1: number;
  /** Was the card beside its text at each moment? */
  beside0: boolean;
  beside1: boolean;
}

/**
 * The page never follows the transcript (owner, 2026-09-11: "Never follow").
 * The reader sits at the top, beside the comments, while the words grow
 * past the bottom edge — and then scrolls down by hand to reach them.
 */
export interface UntouchedReading {
  /** The pane's offset before the words arrived, and after. */
  scrollTop0: number;
  scrollTop1: number;
  /** The control: the document really grew under the reader. */
  scrollHeight0: number;
  scrollHeight1: number;
  /** The control: the transcript began on screen and its foot ended past the
   *  bottom edge — so a page that followed would have had to move. */
  zoneOnScreen0: boolean;
  zoneBottomBelowFold1: boolean;
  /** Comments whose text was on screen, before and after. */
  anchorsOnScreen0: number;
  anchorsOnScreen1: number;
  /** The reader scrolls to the foot: where the pane went, and whether the
   *  newest words are on screen there. */
  handScrollTop: number;
  newestOnScreen: boolean;
  /** More words arrive with the reader at the foot: the offset after. */
  handScrollTop1: number;
}

const WORDS = (
  'so the thing I keep coming back to is that we never wrote down what the acceptance bar was ' +
  'for the Riverbend rollout and it kept biting us every week when the numbers came back ' +
  'different from what the Harborlight dashboard said and nobody could tell which of the two ' +
  'was lying about it or whether we had simply measured the wrong week and moved on'
).split(' ');

let wordAt = 0;
function speech(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[wordAt++ % WORDS.length] as string);
  return out.join(' ');
}

const frame = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Long enough that every comment is a screen or more above the transcript. */
function fixtureMarkdown(paragraphs: number): string {
  const out: string[] = ['# Riverbend weekly'];
  for (let i = 0; i < paragraphs; i++) {
    out.push(`Paragraph ${i} — ${WORDS.slice(i % 30, (i % 30) + 22).join(' ')}.`);
  }
  return out.join('\n\n');
}

const USER: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };

interface Mounted {
  scope: MountScope;
  editorEl: HTMLElement;
  editor: EditorHandle;
  ydoc: Y.Doc;
  threadIds: string[];
  zone: ReturnType<typeof createMeetingLiveZone>;
  chrome: ReviewChrome;
  refreshHints: () => void;
  /** Threads the "N above" pill is counting right now. */
  hintAbove: () => number;
  insets: () => { top: number; bottom: number };
  /** What a tap on the "N above" pill does — `doc-margin.ts`'s `jumpToThread`
   *  sequence: scroll the sentence a third of the way down, then ask the
   *  column for its card. */
  jumpTo: (id: string) => boolean;
}

/** The review editor exactly as `doc-margin.ts` wires it, plus a meeting. */
function mount(
  o: { paragraphs: number; threads: number } = { paragraphs: 60, threads: 4 },
): Mounted {
  const editorEl = document.getElementById('editor') as HTMLElement;
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  fragment.push(prose.parseMarkdownBlocks(fixtureMarkdown(o.paragraphs)));
  const awareness = new Awareness(ydoc);
  const editor = createEditor({ parent: editorEl, ydoc, awareness });
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

  // Comments on the FIRST few paragraphs — the part of the doc a meeting's
  // transcript scrolls away from.
  const threadIds: string[] = [];
  const tiptap = editor.editor;
  let at = 12;
  for (let i = 0; i < o.threads; i++) {
    tiptap.commands.setTextSelection({ from: at, to: at + 20 });
    const sel = editor.getSelectionRel();
    at += 60;
    if (!sel) continue;
    const id = `t-${i}`;
    createThread(ydoc, {
      threadId: id,
      anchor: {
        kind: 'text-range',
        startRel: sel.start,
        endRel: sel.end,
        snippet: { text: sel.snippet },
      },
      createdBy: USER,
      firstComment: { id: `c-${i}`, text: `Comment ${i}` },
    });
    threadIds.push(id);
  }

  const spanFor = (id: string): HTMLElement | null =>
    tiptap.view.dom.querySelector<HTMLElement>(`.thread-range[data-thread-id="${CSS.escape(id)}"]`);

  let hintsInsets: () => { top: number; bottom: number } = () => ({ top: 0, bottom: 0 });
  const margin = mountMarkupMargin({
    editorEl,
    view: tiptap.view,
    getDeletions: () => [],
    threads: () => chrome.collectThreads(),
    chrome,
    getSuggestions: () => [],
    docId: 'd1',
    stripInsets: () => hintsInsets(),
    scope,
  });
  const hints = mountCommentHints({
    scroller: editorEl,
    marginEl: margin.marginEl,
    floatParent: document.getElementById('editor-pane') as HTMLElement,
    threads: () => chrome.collectThreads(),
    spanFor,
    cardsFor: (id) => threadCards(id),
    isNew: (t) => chrome.seen.isNew(t),
    markSeen: (t) => chrome.markSeen(t.id),
    onSeen: () => margin.scheduleRelayout(),
    onInsets: () => margin.scheduleRelayout(),
    onJump: () => {},
    marginVisible: balloonMarginVisible,
    // Never let a dwell quietly mark these threads read mid-probe: the strip
    // that reserves the band is the state under measurement.
    dwellMs: 10 * 60 * 1000,
    reducedMotion: () => true,
    scope,
  });
  hintsInsets = () => hints.insets();
  // What `doc-margin.ts` does on every editor transaction: a note landing in
  // the prose reaches the column through here, not only through its size.
  const onTransaction = (): void => {
    margin.scheduleRelayout();
    hints.refresh();
  };
  tiptap.on('transaction', onTransaction);
  scope.onCleanup(() => tiptap.off('transaction', onTransaction));

  const zone = createMeetingLiveZone({
    parent: editorEl,
    prose: tiptap.view.dom,
    reducedMotion: () => true,
  });
  zone.begin(Date.now());

  return {
    scope,
    editorEl,
    editor,
    ydoc,
    threadIds,
    zone,
    chrome,
    hintAbove: () => {
      const last = hints.last();
      return last ? tallyTotal(last.above) : 0;
    },
    refreshHints: () => {
      hints.refresh();
      margin.relayout();
    },
    insets: () => hints.insets(),
    jumpTo: (id) => {
      const span = spanFor(id);
      if (span) {
        const r = span.getBoundingClientRect();
        const sRect = editorEl.getBoundingClientRect();
        editorEl.scrollTop += r.top - sRect.top - sRect.height * 0.35;
      }
      return margin.revealThreadBalloon(id);
    },
  };
}

/** One transcript turn, the way the engine emits one. */
let turnId = 0;
function utter(m: Mounted, words: number): void {
  const id = turnId++;
  m.zone.onTurn({ turn: id, text: speech(words), final: true, speaker: 'A' });
}

/** Where every comment card is, against the text it marks. */
function read(m: Mounted): Reading {
  const paneRect = m.editorEl.getBoundingClientRect();
  const paneTop = paneRect.top;
  const paneBottom = paneRect.top + m.editorEl.clientHeight;
  const inPane = (r: DOMRect): boolean => r.height > 0 && r.bottom > paneTop && r.top < paneBottom;
  const tiptap = m.editor.editor;
  const per: CardReading[] = [];
  let cards = 0;
  for (const id of m.threadIds) {
    const anchor = tiptap.view.dom.querySelector<HTMLElement>(
      `.thread-range[data-thread-id="${CSS.escape(id)}"]`,
    );
    // Every painted copy of the card INSIDE THE DOCUMENT — a balloon in the
    // margin, the inline card in the flow — so the reading is about the
    // surface in force rather than about one module's DOM. The threads drawer
    // renders a row per thread too and is deliberately excluded: a list of
    // every comment on the doc is not a claim about the text beside it, and
    // counting it would make this measurement about the wrong pane.
    const els = threadCards(id).filter((el) => {
      if (!m.editorEl.contains(el)) return false;
      const s = getComputedStyle(el as HTMLElement);
      return s.display !== 'none' && s.visibility !== 'hidden';
    }) as HTMLElement[];
    if (els.length > 0) cards++;
    const a = anchor?.getBoundingClientRect() ?? null;
    let best: CardReading | null = null;
    for (const el of els) {
      const c = el.getBoundingClientRect();
      const reading: CardReading = {
        id,
        cardOnScreen: inPane(c),
        anchorOnScreen: a !== null && inPane(a),
        offsetFromAnchor: a ? c.top - a.top : Number.NaN,
        cardTop: c.top,
        cardBottom: c.bottom,
        anchorTop: a?.top ?? Number.NaN,
        anchorBottom: a?.bottom ?? Number.NaN,
      };
      // Report the WORST copy: a card painted on screen against off-screen
      // text is the fault, wherever else another copy of it sits.
      if (!best || (reading.cardOnScreen && !best.cardOnScreen)) best = reading;
    }
    if (best) per.push(best);
  }
  const band = m.insets();
  const zoneEl = document.querySelector('.live-zone') as HTMLElement | null;
  const zoneRect = zoneEl?.getBoundingClientRect() ?? null;
  const detachedCards = per.filter((p) => p.cardOnScreen && !p.anchorOnScreen);
  return {
    detached: detachedCards.length,
    worstDetachment: detachedCards.reduce((w, p) => Math.max(w, Math.abs(p.offsetFromAnchor)), 0),
    beside: per.filter((p) => p.cardOnScreen && p.anchorOnScreen).length,
    placement: cardPlacement(),
    marginVisible: balloonMarginVisible(),
    threads: m.threadIds.length,
    cards,
    paneTop,
    paneBottom,
    scrollTop: m.editorEl.scrollTop,
    scrollHeight: m.editorEl.scrollHeight,
    clientHeight: m.editorEl.clientHeight,
    bandTop: band.top,
    bandBottom: band.bottom,
    zoneOnScreen: zoneRect !== null && zoneRect.height > 0 && inPane(zoneRect),
    zoneHeight: zoneRect?.height ?? 0,
    per,
  };
}

/** Settle every debounce the column and the hints run on. */
async function settle(m: Mounted): Promise<void> {
  await sleep(260);
  m.refreshHints();
  await frame();
  await sleep(160);
  await frame();
}

async function probe(): Promise<string> {
  const m = mount();
  await frame();

  // A meeting runs and the reader scrolls down to watch the transcript at
  // the foot, which takes every comment off the top of the screen.
  for (let i = 0; i < 14; i++) {
    utter(m, 9);
    await sleep(20);
  }
  toFoot(m);
  await settle(m);
  const watching = read(m);

  // The reader goes back to one comment's own text.
  const target = m.threadIds[1] as string;
  const span = m.editor.editor.view.dom.querySelector<HTMLElement>(
    `.thread-range[data-thread-id="${CSS.escape(target)}"]`,
  );
  if (span) {
    const r = span.getBoundingClientRect();
    const s = m.editorEl.getBoundingClientRect();
    m.editorEl.scrollTop += r.top - s.top - m.editorEl.clientHeight * 0.35;
  }
  await settle(m);
  // …and the transcript keeps growing under them.
  for (let i = 0; i < 8; i++) {
    utter(m, 9);
    await sleep(20);
  }
  await settle(m);
  const afterScrollBack = read(m);

  teardown(m);

  const held = await heldArm();
  const jumped = await jumpArm();
  const untouched = await untouchedArm();
  const clamped = await clampedArm();
  const landed = await landedArm();
  const out: Probe = {
    watching,
    afterScrollBack,
    target,
    held,
    jumped,
    untouched,
    clamped,
    landed,
  };
  return JSON.stringify(out);
}

/** The reader scrolls the pane down to its foot, by hand. */
function toFoot(m: Mounted): void {
  m.editorEl.scrollTop = m.editorEl.scrollHeight - m.editorEl.clientHeight;
}

/** Take the whole surface back out — the next arm mounts into a clean pane. */
function teardown(m: Mounted): void {
  m.zone.destroy();
  m.scope.dispose();
  m.editor.destroy();
  m.editorEl.replaceChildren();
  m.editorEl.className = 'prose';
  m.editorEl.scrollTop = 0;
}

declare global {
  interface Window {
    commentsInViewProbe: () => Promise<string>;
  }
}
window.commentsInViewProbe = probe;

/**
 * The reader stops on a comment in the MIDDLE of the doc and the meeting keeps
 * going: notes land in the prose, the transcript grows at the foot. Does the
 * page move under them, and does the card stay beside the text?
 *
 * Mid-doc on purpose. Scroll-top is a degenerate parking spot — the browser
 * cannot move a pane that is already at its own zero, so a reading taken there
 * would report "held" whatever the page did.
 */
async function heldArm(): Promise<HeldReading> {
  const m = mount({ paragraphs: 60, threads: 6 });
  await frame();
  for (let i = 0; i < 10; i++) {
    utter(m, 9);
    await sleep(20);
  }
  await settle(m);

  // Park on the LAST comment — a third of the way down, and a long way from
  // either end of the pane.
  const id = m.threadIds[m.threadIds.length - 1] as string;
  const tiptap = m.editor.editor;
  const anchorOf = (): DOMRect | null =>
    tiptap.view.dom
      .querySelector<HTMLElement>(`.thread-range[data-thread-id="${CSS.escape(id)}"]`)
      ?.getBoundingClientRect() ?? null;
  const cardOf = (): DOMRect | null => {
    const els = threadCards(id).filter(
      (el) => m.editorEl.contains(el) && getComputedStyle(el as HTMLElement).display !== 'none',
    );
    return (els[0] as HTMLElement | undefined)?.getBoundingClientRect() ?? null;
  };
  const r = anchorOf();
  const pane = m.editorEl.getBoundingClientRect();
  if (r) m.editorEl.scrollTop += r.top - pane.top - m.editorEl.clientHeight * 0.35;
  await settle(m);
  const a0 = anchorOf();
  const c0 = cardOf();
  const scrollTop0 = m.editorEl.scrollTop;
  const scrollHeight0 = m.editorEl.scrollHeight;

  // The meeting writes on: notes into the prose, words into the transcript.
  const proseEl = tiptap.view.dom;
  for (let i = 0; i < 8; i++) {
    const p = document.createElement('p');
    p.textContent = `Note ${i}: ${speech(12)}`;
    proseEl.append(p);
    utter(m, 9);
    await sleep(30);
    m.refreshHints();
    await frame();
  }
  await settle(m);
  const a1 = anchorOf();
  const c1 = cardOf();

  const beside = (a: DOMRect | null, c: DOMRect | null): boolean =>
    a !== null && c !== null && Math.abs(c.top - a.top) < 200;
  const out: HeldReading = {
    anchorTop0: a0?.top ?? Number.NaN,
    anchorTop1: a1?.top ?? Number.NaN,
    cardTop0: c0?.top ?? Number.NaN,
    cardTop1: c1?.top ?? Number.NaN,
    scrollTop0,
    scrollTop1: m.editorEl.scrollTop,
    scrollHeight0,
    scrollHeight1: m.editorEl.scrollHeight,
    beside0: beside(a0, c0),
    beside1: beside(a1, c1),
  };
  teardown(m);
  return out;
}

/**
 * The reader is watching the transcript and taps the "N above" pill.
 *
 * This is what "reachable" has to mean while a meeting is running: the column
 * draws nothing for text the reader cannot see, so the strip is the way back
 * to a comment — and the card has to be beside its sentence the moment the
 * jump lands, not a debounce later.
 */
async function jumpArm(): Promise<JumpReading> {
  const m = mount({ paragraphs: 60, threads: 4 });
  await frame();
  for (let i = 0; i < 14; i++) {
    utter(m, 9);
    await sleep(20);
  }
  toFoot(m);
  await settle(m);
  const before = read(m);

  const id = m.threadIds[1] as string;
  const revealed = m.jumpTo(id);
  await frame();
  const after = read(m);
  const p = after.per.find((x) => x.id === id);

  const out: JumpReading = {
    watchingBefore: before.zoneOnScreen,
    anchorsOnScreenBefore: before.per.filter((x) => x.anchorOnScreen).length,
    revealed,
    anchorOnScreen: p?.anchorOnScreen ?? false,
    cardOnScreen: p?.cardOnScreen ?? false,
    offsetFromAnchor: p?.offsetFromAnchor ?? Number.NaN,
  };
  teardown(m);
  return out;
}

/**
 * The reader stays at the top, beside the comments, while the meeting talks:
 * a short doc, so the transcript starts on screen under the prose and grows
 * past the bottom edge. The page must not move — and the words must still be
 * there when the reader scrolls down for them.
 */
async function untouchedArm(): Promise<UntouchedReading> {
  const m = mount({ paragraphs: 4, threads: 2 });
  m.editorEl.scrollTop = 0;
  utter(m, 9);
  await settle(m);
  const before = read(m);
  const scrollTop0 = m.editorEl.scrollTop;
  const scrollHeight0 = m.editorEl.scrollHeight;

  for (let i = 0; i < 60; i++) {
    utter(m, 9);
    await sleep(10);
  }
  await settle(m);
  const after = read(m);
  const zoneEl = document.querySelector('.live-zone') as HTMLElement;
  const newest = (): DOMRect | undefined => {
    const turns = zoneEl.querySelectorAll('.lz-turn');
    return turns[turns.length - 1]?.getBoundingClientRect();
  };
  const scrollTop1 = m.editorEl.scrollTop;
  const scrollHeight1 = m.editorEl.scrollHeight;
  const zoneBottomBelowFold1 = zoneEl.getBoundingClientRect().bottom > after.paneBottom;

  // Down to the foot by hand. The "N above" strip arrives once the comments
  // leave the screen and takes its band out of the pane, so the first scroll
  // can stop short of the end — the reader scrolls again, as they would.
  toFoot(m);
  await settle(m);
  toFoot(m);
  await settle(m);
  const handScrollTop = m.editorEl.scrollTop;
  const foot = read(m);
  const last = newest();
  const newestOnScreen =
    last !== undefined &&
    last.height > 0 &&
    last.bottom <= foot.paneBottom &&
    last.top >= foot.paneTop;
  utter(m, 9);
  utter(m, 9);
  await settle(m);

  const out: UntouchedReading = {
    scrollTop0,
    scrollTop1,
    scrollHeight0,
    scrollHeight1,
    zoneOnScreen0: before.zoneOnScreen,
    zoneBottomBelowFold1,
    anchorsOnScreen0: before.per.filter((x) => x.anchorOnScreen).length,
    anchorsOnScreen1: after.per.filter((x) => x.anchorOnScreen).length,
    handScrollTop,
    newestOnScreen,
    handScrollTop1: m.editorEl.scrollTop,
  };
  teardown(m);
  return out;
}

/** Balloons in the margin with a painted box — zero where there is no margin. */
function balloonsPainted(m: Mounted): number {
  return Array.from(m.editorEl.querySelectorAll<HTMLElement>('.cw-balloon-comment')).filter(
    (el) => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0,
  ).length;
}

/**
 * An expanded card whose text has just scrolled off the top, near the top of
 * the doc — where there is no room above the fold to put it.
 */
export interface ClampedReading {
  placement: string;
  balloonsPainted: number;
  /** The control: the card is taller than the scroll offset, so it cannot
   *  sit wholly above the fold and still below the document's top. */
  cardHeight: number;
  scrollTop: number;
  /** The expanded card's text is off screen… */
  anchorOnScreen: boolean;
  /** …and so, the rule says, is its card. */
  cardOnScreen: boolean;
  /** Its card's top and bottom against the pane's top, in px. */
  cardTop: number;
  cardBottom: number;
  /** The "N above" pill still counts it. */
  hintAbove: number;
  /** Back at the top: the text returns and the card with it. */
  back: CardReading | null;
}

async function clampedArm(): Promise<ClampedReading> {
  const m = mount({ paragraphs: 60, threads: 4 });
  await frame();
  const id = m.threadIds[0] as string;
  // The reader has just written on the doc's first comment: its card is open,
  // replies and composer and all.
  m.chrome.threadsPanel.setActive(id);
  await settle(m);
  const pane = m.editorEl.getBoundingClientRect();
  const span = m.editor.editor.view.dom.querySelector<HTMLElement>(
    `.thread-range[data-thread-id="${CSS.escape(id)}"]`,
  );
  const anchorBottom =
    (span?.getBoundingClientRect().bottom ?? 0) - pane.top + m.editorEl.scrollTop;
  // Scroll the sentence just off the top — a little reading, nothing more.
  m.editorEl.scrollTop = Math.ceil(anchorBottom) + 24;
  await settle(m);
  const r = read(m);
  const p = r.per.find((x) => x.id === id);
  const card = threadCards(id).find((el) => m.editorEl.contains(el)) as HTMLElement | undefined;
  const cardHeight = card?.offsetHeight ?? 0;
  const scrollTop = m.editorEl.scrollTop;
  const hintAbove = m.hintAbove();

  m.editorEl.scrollTop = 0;
  await settle(m);
  const back = read(m).per.find((x) => x.id === id) ?? null;
  const out: ClampedReading = {
    placement: r.placement,
    balloonsPainted: balloonsPainted(m),
    cardHeight,
    scrollTop,
    anchorOnScreen: p?.anchorOnScreen ?? false,
    cardOnScreen: p?.cardOnScreen ?? false,
    cardTop: (p?.cardTop ?? Number.NaN) - r.paneTop,
    cardBottom: (p?.cardBottom ?? Number.NaN) - r.paneTop,
    hintAbove,
    back,
  };
  teardown(m);
  return out;
}

/** Notes landing in the prose above the reader's comments, mid-meeting. */
export interface LandedReading {
  placement: string;
  balloonsPainted: number;
  /** Before anything lands: every comment's text and card on screen. */
  before: Reading;
  /** Six notes land under the title, above every comment but the one ON the
   *  title; read ONE frame later. The text has moved down, still on screen. */
  nudged: Reading;
  /** Each card's offset from its text one frame after the notes landed, and
   *  once every debounce has run — where the column means to put it. */
  offsetsNudged: number[];
  offsetsSettled: number[];
  /** Sixteen more land and push that text off the bottom. One frame later. */
  pushed: Reading;
}

async function landedArm(): Promise<LandedReading> {
  const m = mount({ paragraphs: 30, threads: 4 });
  for (let i = 0; i < 6; i++) utter(m, 9);
  m.editorEl.scrollTop = 0;
  await settle(m);
  const before = read(m);
  const tiptap = m.editor.editor;
  // Straight under the title, in one transaction each — the way a tick's
  // block edits arrive — while the transcript keeps growing at the foot.
  const underTitle = tiptap.state.doc.firstChild?.nodeSize ?? 0;
  const notes = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: `Note ${i}: ${speech(18)}` }],
    }));
  const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
  const offsets = (r: Reading): number[] => r.per.map((p) => Math.round(p.offsetFromAnchor));

  tiptap.commands.insertContentAt(underTitle, notes(6));
  utter(m, 9);
  await nextFrame();
  const nudged = read(m);
  await settle(m);
  const settled = read(m);

  tiptap.commands.insertContentAt(underTitle, notes(16));
  utter(m, 9);
  await nextFrame();
  const pushed = read(m);

  const out: LandedReading = {
    placement: before.placement,
    balloonsPainted: balloonsPainted(m),
    before,
    nudged,
    offsetsNudged: offsets(nudged),
    offsetsSettled: offsets(settled),
    pushed,
  };
  teardown(m);
  return out;
}
