/**
 * The fixture, the reading shapes and the page-side scripts
 * `body-typing-remote-edit-driver.ts` runs: the plan the reader types into,
 * what they type, and the helpers installed in the page that read where the
 * caret is and which words sit beside it.
 */

export const FILLER =
  'The Riverbend crossing carries commuters at dawn and freight at noon, and the ' +
  'Saltmarsh tide table decides which of the two slipways can take a loaded ferry.';

/** The words the reader's caret sits after. */
export const CARET_AFTER = 'The quiet berth';
/** What follows the caret in the same sentence, before any typing. */
export const CARET_BEFORE = ' opens in spring.';
/** The paragraph the reader types into. */
export const CARET_PIER = 17;

/** Paragraph `i` of the plan. Every one starts with a label the driver
 *  finds it by in the outline. */
export const pier = (i: number): string =>
  i === CARET_PIER
    ? `Pier ${i}: ${FILLER} ${CARET_AFTER}${CARET_BEFORE}`
    : `Pier ${i}: ${FILLER} ${FILLER}`;

/** Thirty paragraphs, with a heading before every fifth. */
export const PLAN = [
  '# Harborlight ferry plan',
  ...Array.from({ length: 30 }, (_, i) => [
    ...(i % 5 === 0 ? [`## Section ${i / 5}`] : []),
    pier(i),
  ]).flat(),
].join('\n\n');

/** What the reader types: a chunk before the first edit and after each one. */
export const WORDS = [
  ' where Alice',
  ' signs',
  ' the',
  ' Saltmarsh',
  ' survey',
  ' and',
  ' Bob',
  ' checks',
  ' the',
  ' Riverbend',
  ' slipway',
  ' first',
];

/** One reading of the page, taken once it has settled. */
export interface CaretReading {
  /** Where focus is: the doc's editor, a comment box, `body` when focus was
   *  dropped, or elsewhere. */
  focus: 'doc' | 'composer' | 'body' | 'other';
  /** The forty characters before the caret, inside its block. */
  beforeCaret: string | null;
  /** The caret's top edge in viewport pixels. */
  caretTop: number | null;
  /** The top of the words the caret sits after, in viewport pixels. The
   *  reader's own typing goes after them, so only an edit moves them. */
  wordsTop: number | null;
  /** The text of the paragraph the reader is typing into. */
  para: string | null;
  scrollTop: number;
}

/** One agent edit (or a burst of them): read before, once on the page, and
 *  after the reader typed on. */
export interface BodyStep {
  where: string;
  before: CaretReading;
  landed: CaretReading;
  after: CaretReading;
  /** Every word the reader had typed by `after`. */
  typed: string;
}

export interface BodyScenario {
  width: number;
  height: number;
  mode: 'one-by-one' | 'burst';
  opened: CaretReading;
  steps: BodyStep[];
  final: CaretReading;
  typed: string;
}

export interface BodyRun {
  scenarios: BodyScenario[];
}

/** Page helpers: `__read()` reports a `CaretReading`. */
export const HELPERS = `(() => {
  const AFTER = ${JSON.stringify(CARET_AFTER)};
  window.__pm = () => document.querySelector('#editor .ProseMirror');
  /** The text node and offset of a phrase inside the doc body. */
  window.__find = (needle) => {
    const walker = document.createTreeWalker(__pm(), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.data.indexOf(needle);
      if (at >= 0 && !n.parentElement.closest('.cw-inline-card, .thread')) return { node: n, at };
    }
    return null;
  };
  window.__para = () => {
    const hit = __find(AFTER);
    const el = hit && hit.node.parentElement.closest('p');
    return el ? el.textContent : null;
  };
  window.__read = () => {
    const a = document.activeElement;
    const pm = __pm();
    const focus = a && pm && (a === pm || pm.contains(a)) && !a.closest('.thread, .cw-inline-card')
      ? 'doc'
      : a && a.closest && a.closest('.md-composer-surface') ? 'composer'
      : a === document.body || a === null ? 'body' : 'other';
    const sel = getSelection();
    let beforeCaret = null;
    let caretTop = null;
    if (sel && sel.rangeCount && pm && pm.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0);
      const block = (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement).closest('p, li, h1, h2, h3');
      if (block) {
        const pre = document.createRange();
        pre.setStart(block, 0);
        pre.setEnd(r.startContainer, r.startOffset);
        beforeCaret = pre.toString().slice(-40);
      }
      const rects = r.getClientRects();
      const box = rects.length ? rects[0] : r.getBoundingClientRect();
      caretTop = box && (box.height > 0 || box.top !== 0) ? Math.round(box.top) : null;
    }
    const hit = __find(AFTER);
    let wordsTop = null;
    if (hit) {
      const w = document.createRange();
      w.setStart(hit.node, hit.at);
      w.setEnd(hit.node, hit.at + 1);
      wordsTop = Math.round(w.getBoundingClientRect().top);
    }
    return {
      focus,
      beforeCaret,
      caretTop,
      wordsTop,
      para: __para(),
      scrollTop: Math.round(document.querySelector('#editor').scrollTop),
    };
  };
  window.__settled = async () => {
    for (let i = 0; i < 300; i++) {
      const moving = document.getAnimations().some((x) => x.playState === 'running');
      const before = document.querySelector('#editor').scrollTop;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (!moving && document.querySelector('#editor').scrollTop === before) return true;
    }
    return false;
  };
  /** Where the caret goes, in viewport pixels: right after AFTER. */
  window.__caretSpot = () => {
    const hit = __find(AFTER);
    const r = document.createRange();
    r.setStart(hit.node, hit.at + AFTER.length - 1);
    r.setEnd(hit.node, hit.at + AFTER.length);
    const b = r.getBoundingClientRect();
    return { x: Math.round(b.right - 1), y: Math.round(b.top + b.height / 2) };
  };
  /** Put the DOM caret exactly after AFTER, as a tap that landed there would. */
  window.__placeCaret = () => {
    const hit = __find(AFTER);
    const sel = getSelection();
    sel.removeAllRanges();
    const r = document.createRange();
    r.setStart(hit.node, hit.at + AFTER.length);
    r.collapse(true);
    sel.addRange(r);
    return true;
  };
  /** Scroll so the caret's words sit \`offset\` px below the scroller top. */
  window.__scrollCaretTo = (offset) => {
    const ed = document.querySelector('#editor');
    const hit = __find(AFTER);
    const r = document.createRange();
    r.setStart(hit.node, hit.at);
    r.setEnd(hit.node, hit.at + 1);
    ed.scrollTop += r.getBoundingClientRect().top - ed.getBoundingClientRect().top - offset;
    return true;
  };
  return true;
})()`;
