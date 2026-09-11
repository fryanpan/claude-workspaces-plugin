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
import { mountCommentHints } from '../src/comment-hints.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { createMeetingLiveZone } from '../src/meeting-live-zone.ts';
import { MountScope } from '../src/mount-scope.ts';
import { mountMarkupMargin } from '../src/redline/markup-margin.ts';
import { mountReviewChrome } from '../src/review-chrome.ts';
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
  /** Is the live transcript's last line on screen (follow mode holding)? */
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
  /** The state a meeting reaches on its own: transcript at the foot, the
   *  reader following it, every comment far above. */
  following: Reading;
  /** The reader scrolls up to one comment's own text, then the transcript
   *  keeps growing. Does the comment stay beside its text? */
  afterScrollBack: Reading;
  /** The thread the reader scrolled to in `afterScrollBack`. */
  target: string;
  /** The reader parked on a comment MID-doc while the meeting runs on. */
  held: HeldReading;
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
  refreshHints: () => void;
  insets: () => { top: number; bottom: number };
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
    refreshHints: () => {
      hints.refresh();
      margin.relayout();
    },
    insets: () => hints.insets(),
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

  // A meeting runs: the transcript grows at the foot and follow mode holds it
  // in view, which is what takes every comment off the top of the screen.
  for (let i = 0; i < 14; i++) {
    utter(m, 9);
    await sleep(20);
  }
  await settle(m);
  const following = read(m);

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
  const out: Probe = { following, afterScrollBack, target, held };
  return JSON.stringify(out);
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
