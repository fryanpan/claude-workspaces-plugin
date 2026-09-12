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
import { mountReadingHold } from '../src/reading-hold.ts';
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
  /** The reader parked at the very foot while a note lands below their line. */
  bottomStill: StillReading;
  /** The reader mid-doc, notes landing ABOVE them, on a browser with no
   *  scroll anchoring of its own — an iPad before Safari 27. */
  aboveStill: StillReading;
  /** The reader parked mid-doc while a block above them grows with no DOM
   *  mutation at all — an image finishing its load. */
  grownStill: StillReading;
  /** The reader parked mid-doc while the paragraph running up past the top of
   *  the pane rewraps above the fold — its box grows, its own top does not
   *  move. */
  rewrapStill: StillReading;
  /** The reader parked mid-doc while the tick REBUILDS the block they are on
   *  and lands notes above it. */
  replaceStill: StillReading;
  /** A block-rewriting tick arriving as a remote update: do the cards stay? */
  cardsKept: CardsKeptReading;
  /** The document arriving under a pane nobody has touched: is its own first
   *  heading on screen once it has? */
  opened: OpenedReading;
}

/**
 * A doc opening: the editor is built empty, the hold mounts over it, and the
 * document's blocks arrive afterwards — the boot order the real page has.
 */
export interface OpenedReading {
  /** Blocks in the prose when the hold took its first reading. One: the empty
   *  paragraph ProseMirror renders for an empty document. */
  blocksAtMount: number;
  /** …and after the sync, so a run where nothing arrived cannot read as a
   *  pass. */
  blocksAfter: number;
  scrollHeightBefore: number;
  scrollHeightAfter: number;
  clientHeight: number;
  /** Where the pane came to rest. Nobody scrolled it. */
  scrollTop: number;
  /** The pane's own top edge — on the real page, the line the top bar ends on. */
  paneTop: number;
  headingTop: number;
  headingBottom: number;
  headingText: string;
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
  const onTransaction = (props: { transaction: { docChanged: boolean } }): void => {
    if (props.transaction.docChanged) {
      chrome.refreshThreadDecorations(chrome.threadsPanel.getActive());
    }
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
  // The page's own hold, mounted where `doc-margin.ts` mounts it.
  mountReadingHold({ scroller: editorEl, scope });

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
  // First, into a pane nothing has mounted into yet: the doc's own opening.
  const opened = await openedArm();

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
  const bottomStill = await stillArm({ where: 'bottom', suppressAnchoring: false });
  const aboveStill = await stillArm({ where: 'mid', suppressAnchoring: true });
  const grownStill = await stillArm({ where: 'mid', suppressAnchoring: true, change: 'grow' });
  const rewrapStill = await stillArm({ where: 'mid', suppressAnchoring: true, change: 'rewrap' });
  const replaceStill = await stillArm({ where: 'mid', suppressAnchoring: true, change: 'replace' });
  const cardsKept = await cardsKeptArm();
  const out: Probe = {
    watching,
    afterScrollBack,
    target,
    held,
    jumped,
    untouched,
    clamped,
    landed,
    bottomStill,
    aboveStill,
    grownStill,
    rewrapStill,
    replaceStill,
    cardsKept,
    opened,
  };
  return JSON.stringify(out);
}

/**
 * A DOC OPENS WITH ITS OWN TITLE ON SCREEN.
 *
 * The boot order the real page has, and the one every other arm here skips by
 * filling the ydoc before it builds the editor: the editor is created over an
 * EMPTY document, the hold mounts over that, and the document's blocks arrive
 * afterwards — on the live server, ~13ms later, when the first sync lands.
 *
 * What that used to do. ProseMirror renders an empty document as one empty
 * paragraph, so the hold's first reading was taken against it; the sync then
 * put the heading in above that paragraph and reused the paragraph for the
 * doc's first one, which moved it down the pane. The hold corrected by exactly
 * that much — 71px at 1180x820 and 48px at 430x932, measured on the live
 * server — and the doc's own H1 went above the pane's clip box and under the
 * top bar, on every doc, before anyone had touched anything.
 */
async function openedArm(): Promise<OpenedReading> {
  const editorEl = document.getElementById('editor') as HTMLElement;
  const ydoc = new Y.Doc();
  const editor = createEditor({ parent: editorEl, ydoc, awareness: new Awareness(ydoc) });
  const scope = new MountScope();
  // Mounted where `doc-margin.ts` mounts it: over an editor that has no
  // document yet.
  mountReadingHold({ scroller: editorEl, scope });
  await frame();

  const proseEl = editor.editor.view.dom;
  const blocksAtMount = proseEl.children.length;
  const scrollHeightBefore = editorEl.scrollHeight;

  // The first sync, in one transaction, the way `whenSynced` delivers it.
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(fixtureMarkdown(60)));
  await frame();
  await sleep(160);
  await frame();

  const heading = proseEl.querySelector('h1');
  const headingRect = heading?.getBoundingClientRect();
  const reading: OpenedReading = {
    blocksAtMount,
    blocksAfter: proseEl.children.length,
    scrollHeightBefore,
    scrollHeightAfter: editorEl.scrollHeight,
    clientHeight: editorEl.clientHeight,
    scrollTop: editorEl.scrollTop,
    paneTop: editorEl.getBoundingClientRect().top,
    headingTop: headingRect?.top ?? Number.NaN,
    headingBottom: headingRect?.bottom ?? Number.NaN,
    headingText: heading?.textContent ?? '',
  };

  scope.dispose();
  editor.destroy();
  editorEl.replaceChildren();
  editorEl.className = 'prose';
  editorEl.scrollTop = 0;
  return reading;
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

/**
 * Does the line the reader is actually looking at stay on its pixel while the
 * meeting writes into the doc?
 *
 * Measured on a paragraph of the PROSE chosen before anything lands — the
 * topmost one on screen — and sampled every frame, so a correction that
 * arrives a frame late reads as a drift rather than as a hold.
 */
export interface StillReading {
  /** Where the reader was parked, and whether the browser's own scroll
   *  anchoring was suppressed for this arm (an iPad before Safari 27). */
  where: 'bottom' | 'mid';
  /** What changed above the reader's line: notes written into the prose, or a
   *  block above it growing with the DOM untouched — an image or an embed
   *  finishing its load, which no mutation reports. */
  change: 'notes' | 'grow' | 'rewrap' | 'replace';
  anchoringSuppressed: boolean;
  /** What this browser would do on its own, unsuppressed. */
  supportsAnchoring: boolean;
  /** What the pane's own `overflow-anchor` computes to: the page holds the
   *  reader's line itself, so the browser must not also be holding one of its
   *  own choosing. `none` is the page having taken the decision. */
  paneOverflowAnchor: string;
  /** The control: a real paragraph of the prose, on screen when the notes
   *  landed. */
  eyeOnScreen: boolean;
  eyeText: string;
  /** Its top against the pane's top, before and after. */
  eyeTop0: number;
  eyeTop1: number;
  /** The worst departure from `eyeTop0` in ANY frame of the tick. */
  worstDrift: number;
  frames: number;
  /** Where in the document that line sits, before and after: growth above it
   *  moves it, growth below it does not. Which of the two this arm built is
   *  the control for what the hold had to do. */
  eyeContentY0: number;
  eyeContentY1: number;
  scrollTop0: number;
  scrollTop1: number;
  /** The control: the document really grew under the reader. */
  scrollHeight0: number;
  scrollHeight1: number;
  /** The control for `bottom`: the pane really was at the end of its travel. */
  atBottom0: boolean;
  /** The control for `rewrap`: a block really did run up past the top of the
   *  pane, so there really was a box whose own top could not move. */
  straddledTop: boolean;
  /** The control for `replace`: the element the reading started on really did
   *  leave the document, so the hold had nothing of the reader's own line
   *  left to measure against. */
  replaced: boolean;
  /** Frames in which the reader's line was not in the document at all — the
   *  window between taking the block out and writing it back. */
  framesWithoutLine: number;
}

/**
 * A tick that REWRITES blocks, arriving the way a second viewer gets one:
 * applied to another copy of the doc and synced in as a remote update.
 *
 * Grouping a topic in place (PR 863) deletes the bullets it groups and writes
 * them back as list items, so every comment anchored in them stops resolving
 * at that instant — and the card that was in the flow under the sentence goes
 * with it, taking its height out of the document under the reader. Measured
 * on the live board at 430: every inline card gone for 2.2s, 276px of flow
 * with them, the pane clamped 1492 → 1310 → 1492.
 */
export interface CardsKeptReading {
  placement: string;
  threads: number;
  /** The control: the tick really rewrote blocks. */
  editsApplied: number;
  editsFailed: number;
  /** Frames sampled from just before the tick to well past it. */
  frames: number;
  /** The fewest cards in the document in ANY of those frames — the fault,
   *  counted. Equal to `threads` when nothing ever left. */
  minCards: number;
  /** How many of those frames were short of a card. */
  framesMissing: number;
  /** The flow's height before the tick, its low-water mark through it, and
   *  where it ended: a card leaving takes its own height out of the document. */
  scrollHeight0: number;
  minScrollHeight: number;
  scrollHeight1: number;
  outcomes: string[];
  threadsCollected: number;
  cardsAnywhere: number;
  rangeSpans: number;
  resolvedBefore: boolean[];
  resolvedAfter: boolean[];
  resolvedEnd: boolean[];
}

/** Emulate a browser with no scroll anchoring of its own — Safari 26 and
 *  every iPad before it. Removing the sheet gives the browser back. */
function suppressNativeAnchoring(on: boolean): void {
  const id = 'civ-no-anchor';
  document.getElementById(id)?.remove();
  if (!on) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = '*{overflow-anchor:none!important}';
  document.head.append(style);
}

async function stillArm(o: {
  where: 'bottom' | 'mid';
  suppressAnchoring: boolean;
  change?: 'notes' | 'grow' | 'rewrap' | 'replace';
}): Promise<StillReading> {
  const change = o.change ?? 'notes';
  const m = mount({ paragraphs: 40, threads: 4 });
  await frame();
  for (let i = 0; i < 10; i++) {
    utter(m, 9);
    await sleep(20);
  }
  await settle(m);
  suppressNativeAnchoring(o.suppressAnchoring);

  const tiptap = m.editor.editor;
  if (o.where === 'bottom') {
    // Twice, as `untouchedArm` does: the strip that arrives once the comments
    // leave the screen takes its band out of the pane, so the first scroll can
    // stop short of the end.
    toFoot(m);
    await settle(m);
    toFoot(m);
  } else {
    m.editorEl.scrollTop = Math.round((m.editorEl.scrollHeight - m.editorEl.clientHeight) * 0.4);
  }
  await settle(m);

  const paneTop = (): number => m.editorEl.getBoundingClientRect().top;
  // The reader's line: the topmost paragraph of the PROSE still on screen.
  // Chosen here and never re-chosen — the whole reading is about this one
  // element's pixel.
  const top0 = paneTop();
  const eye =
    Array.from(tiptap.view.dom.children).find((el) => {
      const r = el.getBoundingClientRect();
      // The first paragraph that BEGINS on screen — the line the reader's eye
      // is on, and the one the hold holds. A paragraph running up past the
      // top of the pane is not it: its box starts off screen.
      return (
        r.height > 0 &&
        r.top >= top0 - 1 &&
        r.bottom > top0 + 1 &&
        r.top < top0 + m.editorEl.clientHeight
      );
    }) ?? null;
  // THE READER'S LINE, NOT THE ELEMENT. A tick can rebuild the very node the
  // reading started on, and the words are still on screen afterwards — so the
  // measurement follows the TEXT: the element while it lives, and whatever
  // block carries the same opening words once it does not.
  const eyeKey = (eye?.textContent ?? '').slice(0, 40);
  const eyeNow = (): Element | null => {
    if (eye?.isConnected) return eye;
    if (eyeKey === '') return null;
    return (
      Array.from(tiptap.view.dom.children).find((el) =>
        (el.textContent ?? '').startsWith(eyeKey),
      ) ?? null
    );
  };
  const topOfEye = (): number => {
    const el = eyeNow();
    return el ? el.getBoundingClientRect().top - paneTop() : Number.NaN;
  };
  const eyeTop0 = topOfEye();
  const contentYOfEye = (): number => topOfEye() + m.editorEl.scrollTop;
  const eyeContentY0 = contentYOfEye();
  const scrollTop0 = m.editorEl.scrollTop;
  const scrollHeight0 = m.editorEl.scrollHeight;
  const atBottom0 = scrollTop0 >= scrollHeight0 - m.editorEl.clientHeight - 2;

  // Every frame from here to the end of the tick, so a one-frame jump — the
  // shape a repair that runs after layout leaves behind — cannot hide inside
  // a before/after pair.
  let straddledTop = false;
  let worstDrift = 0;
  let frames = 0;
  let framesWithoutLine = 0;
  let sampling = true;
  const sample = (): void => {
    if (!sampling) return;
    frames++;
    const drift = Math.abs(topOfEye() - eyeTop0);
    // The `replace` arm takes the reader's line out of the document and
    // writes it back, so for a frame or two there is no line to measure.
    // Counted rather than folded into the worst reading, which a NaN would
    // swallow whole.
    if (Number.isNaN(drift)) framesWithoutLine++;
    else worstDrift = Math.max(worstDrift, drift);
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  // The tick: notes under the title — above the reader's line in both arms,
  // which is what the layout has to be corrected for — and words into the
  // transcript at the foot.
  if (change === 'notes') {
    const underTitle = tiptap.state.doc.firstChild?.nodeSize ?? 0;
    tiptap.commands.insertContentAt(underTitle, [
      { type: 'paragraph', content: [{ type: 'text', text: `Note: ${speech(18)}` }] },
      { type: 'paragraph', content: [{ type: 'text', text: `Note: ${speech(18)}` }] },
    ]);
    utter(m, 9);
  } else if (change === 'replace') {
    // THE BLOCK THE READER IS ON, REBUILT. Grouping a topic in place rewrites
    // the blocks it groups, and ProseMirror replaces their DOM nodes — so the
    // element the hold took its reading from is gone from the document by the
    // time the correction runs, in the same tick as notes landing above it.
    // Held on its own the reading would have nothing left to measure, and the
    // reader's line would take the whole growth.
    if (eye) {
      const at = tiptap.view.posAtDOM(eye, 0);
      const $at = tiptap.state.doc.resolve(at);
      const text = eye.textContent ?? '';
      // Taken out and written back, rather than edited in place: an edit
      // inside a paragraph is patched into the element ProseMirror already
      // has, and it is the REBUILD this arm is about. The block comes back
      // with the same text in the same shape, so what the reader sees at the
      // end is the line they started on — at whatever pixel the hold left it.
      tiptap.commands.deleteRange({ from: $at.before(1), to: $at.after(1) });
      tiptap.commands.insertContentAt($at.before(1), {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      });
    }
    const underTitle = tiptap.state.doc.firstChild?.nodeSize ?? 0;
    tiptap.commands.insertContentAt(underTitle, [
      { type: 'paragraph', content: [{ type: 'text', text: `Note: ${speech(18)}` }] },
      { type: 'paragraph', content: [{ type: 'text', text: `Note: ${speech(18)}` }] },
    ]);
    utter(m, 9);
  } else if (change === 'grow') {
    // A block above the reader growing with NO mutation inside the pane: the
    // shape an image, an embed or a font swap leaves behind. The rule is
    // added to the document's head, which the hold's MutationObserver does
    // not watch (it watches the scroller), so the only signal the hold gets
    // is the resize itself — the same signal a decoded image gives it.
    const grow = document.createElement('style');
    grow.textContent = '#editor .ProseMirror > :first-child{min-height:240px}';
    document.head.append(grow);
  } else {
    // A REWRAP INSIDE THE BLOCK THAT STRADDLES THE TOP OF THE PANE. An edit
    // earlier in a long paragraph re-lays its lines above the fold: the
    // element grows downward while its own `top` stays exactly where it was,
    // so a hold reading that box's top sees nothing to correct while the
    // words on screen slide down. Grown here by padding the block's own top,
    // which is the same shape a line added above the fold has: the box grows
    // downward from a top that does not move. The rule goes in the document's
    // head, which the hold does not watch, so the pane sees no mutation.
    const paneTopNow = paneTop();
    const kids = Array.from(tiptap.view.dom.children);
    const at = kids.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.top < paneTopNow - 1 && r.bottom > paneTopNow + 1;
    });
    straddledTop = at >= 0;
    if (at >= 0) {
      // Through the document's head, not the element's own style attribute:
      // the editor redraws its nodes on the next transaction and takes an
      // inline style with it, and a rule in the head survives that.
      const rule = document.createElement('style');
      rule.textContent = `#editor .ProseMirror > :nth-child(${at + 1}){padding-top:120px}`;
      document.head.append(rule);
    }
  }
  await settle(m);
  sampling = false;

  const out: StillReading = {
    where: o.where,
    change,
    anchoringSuppressed: o.suppressAnchoring,
    supportsAnchoring: typeof CSS !== 'undefined' && CSS.supports('overflow-anchor', 'auto'),
    paneOverflowAnchor: getComputedStyle(m.editorEl).overflowAnchor,
    eyeOnScreen: eye !== null,
    eyeText: (eye?.textContent ?? '').slice(0, 40),
    eyeTop0,
    eyeTop1: topOfEye(),
    worstDrift,
    frames,
    eyeContentY0,
    eyeContentY1: contentYOfEye(),
    scrollTop0,
    scrollTop1: m.editorEl.scrollTop,
    scrollHeight0,
    scrollHeight1: m.editorEl.scrollHeight,
    atBottom0,
    straddledTop,
    replaced: eye !== null && !eye.isConnected,
    framesWithoutLine,
  };
  suppressNativeAnchoring(false);
  teardown(m);
  return out;
}

async function cardsKeptArm(): Promise<CardsKeptReading> {
  const m = mount({ paragraphs: 20, threads: 4 });
  await frame();
  for (let i = 0; i < 6; i++) {
    utter(m, 9);
    await sleep(20);
  }
  m.editorEl.scrollTop = 0;
  await settle(m);

  const cardsNow = (): number =>
    m.threadIds.filter((id) => threadCards(id).some((el) => m.editorEl.contains(el))).length;
  const scrollHeight0 = m.editorEl.scrollHeight;
  let minCards = cardsNow();
  let minScrollHeight = scrollHeight0;
  let framesMissing = 0;
  let frames = 0;
  let sampling = true;
  const sample = (): void => {
    if (!sampling) return;
    frames++;
    const n = cardsNow();
    minCards = Math.min(minCards, n);
    if (n < m.threadIds.length) framesMissing++;
    minScrollHeight = Math.min(minScrollHeight, m.editorEl.scrollHeight);
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  // The other copy of the doc — the one the server writes the tick into.
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(m.ydoc));
  prose.ensureBlockIds(remote);
  const ids = prose
    .addressableBlocks(prose.getProseFragment(remote))
    .map((el) => prose.readBlockId(el))
    .filter((id): id is string => id != null);
  const result = prose.applyBlockEdits(
    remote,
    [
      // A tick's own two shapes: a note under the heading it belongs to, and
      // one at the end of the doc. Both are structural edits to the prose
      // ABOVE and BELOW the reader's comments, and neither touches the text
      // any of them is anchored to.
      {
        op: 'insert_under_heading',
        headingId: ids[0] as string,
        markdown: `- Note: ${speech(14)}`,
      },
      { op: 'insert_at_end', markdown: `- Note: ${speech(14)}` },
    ],
    {
      author: 'meeting-notes',
      suggestionAuthor: { id: 'meeting-notes', name: 'Meeting Assistant', color: '#6a8' },
    },
  );
  const resolves = (): boolean[] =>
    m.threadIds.map((id) => m.chrome.resolveThreadRange(id) != null);
  const resolvedBefore = resolves();
  Y.applyUpdate(m.ydoc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(m.ydoc)));
  const resolvedAfter = resolves();
  utter(m, 9);
  await settle(m);
  await sleep(400);
  await settle(m);
  sampling = false;

  const out: CardsKeptReading = {
    placement: cardPlacement(),
    threads: m.threadIds.length,
    editsApplied: result.applied,
    editsFailed: result.failed,
    frames,
    minCards,
    framesMissing,
    scrollHeight0,
    minScrollHeight,
    scrollHeight1: m.editorEl.scrollHeight,
    outcomes: result.outcomes.map((o) => `${o.op}:${o.status}:${o.error ?? ''}`),
    resolvedBefore,
    resolvedAfter,
    resolvedEnd: resolves(),
    threadsCollected: m.chrome.collectThreads().length,
    cardsAnywhere: m.threadIds.reduce((n, id) => n + threadCards(id).length, 0),
    rangeSpans: m.editor.editor.view.dom.querySelectorAll('.thread-range').length,
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
