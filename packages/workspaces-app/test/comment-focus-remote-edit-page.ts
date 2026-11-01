/**
 * The fixture and the page-side scripts `comment-focus-remote-edit-driver.ts`
 * runs: the plan the reader comments on, what they type, and the helpers
 * installed in the page that read where the caret, the box and the commented
 * words are.
 */
import type { ComposerKind } from './comment-focus-remote-edit-reading.ts';

export const FILLER =
  'The Riverbend crossing carries commuters at dawn and freight at noon, and the ' +
  'Saltmarsh tide table decides which of the two slipways can take a loaded ferry.';
/** The thread above the reader's place: the agent inserts blocks after it. */
export const ABOVE = 'north berth';
/** The thread the reader replies to. */
export const TARGET = 'middle berth';
/** The phrase the reader selects for a new comment. */
export const PHRASE = 'quiet berth';
/** The sentence the agent lengthens below the reader's place. */
export const BELOW = 'The south berth closes in winter.';
/** The sentence in the commented paragraph the agent rewrites. */
export const INSIDE = 'Bob counts the bollards.';

export const para = (i: number): string => {
  if (i === 4) return `${FILLER} The ${ABOVE} opens in spring.`;
  if (i === 14) return `${FILLER} The ${TARGET} opens in spring. ${INSIDE}`;
  if (i === 15) return `${FILLER} The ${PHRASE} opens in spring. ${INSIDE}`;
  if (i === 24) return `${FILLER} ${BELOW}`;
  return `${FILLER} ${FILLER}`;
};
export const PLAN = [
  '# Harborlight ferry plan',
  ...Array.from({ length: 30 }, (_, i) => para(i)),
].join('\n\n');

/** What the reader types, a chunk before the first edit and after each one. */
export const CHUNKS = [
  'Alice signs off the berth ',
  'once the Saltmarsh survey is back ',
  'and the tide table agrees, ',
  'so Bob checks the Riverbend slipway first.',
];

/**
 * The page-side helpers. `__box()` is the editable surface the reader types
 * into: the new-comment composer's, or the reply box of the target thread's
 * card (a margin balloon at 1180, an inline card at 430).
 */
export const HELPERS = (kind: ComposerKind, cardSel: string) => `(() => {
  const TARGET = ${JSON.stringify(TARGET)};
  const PHRASE = ${JSON.stringify(PHRASE)};
  window.__card = () => [...document.querySelectorAll(${JSON.stringify(cardSel)})]
    .find((c) => (c.textContent || '').includes('Who signs off the ' + TARGET));
  window.__box = () => {
    ${
      kind === 'new'
        ? `return document.querySelector('#composer .md-composer-surface .ProseMirror');`
        : `const card = __card();
    return card ? card.querySelector('.thread-reply .md-composer-surface .ProseMirror') : null;`
    }
  };
  /** The text node and offset of a phrase inside the doc's ProseMirror. */
  window.__find = (needle) => {
    const root = document.querySelector('#editor .ProseMirror');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.data.indexOf(needle);
      if (at >= 0 && !n.parentElement.closest('.cw-inline-card, .thread')) return { node: n, at };
    }
    return null;
  };
  window.__anchorTop = () => {
    const hit = __find(${kind === 'new' ? 'PHRASE' : 'TARGET'});
    if (!hit) return null;
    const r = document.createRange();
    r.setStart(hit.node, hit.at);
    r.setEnd(hit.node, hit.at + 1);
    return Math.round(r.getBoundingClientRect().top);
  };
  window.__read = () => {
    const box = __box();
    const a = document.activeElement;
    const drawn = box && box.getClientRects().length > 0;
    return {
      focus: box && (a === box || box.contains(a)) ? 'composer'
        : a && a.closest && a.closest('#editor .ProseMirror') && !a.closest('.thread, .cw-inline-card') ? 'doc'
        : a === document.body || a === null ? 'body' : 'other',
      text: box ? box.textContent : null,
      boxTop: drawn ? Math.round(box.getBoundingClientRect().top) : null,
      scrollTop: Math.round(document.querySelector('#editor').scrollTop),
      anchorTop: __anchorTop(),
    };
  };
  window.__settled = async () => {
    // Settled: no animation running, and the scroller still across a frame.
    for (let i = 0; i < 300; i++) {
      const moving = document.getAnimations().some((x) => x.playState === 'running');
      const before = document.querySelector('#editor').scrollTop;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (!moving && document.querySelector('#editor').scrollTop === before) return true;
    }
    return false;
  };
  return true;
})()`;

/** Put the commented words `offset` pixels below the editor's top edge. */
export const scrollAnchorTo = (offset: number) => `(() => {
  const ed = document.querySelector('#editor');
  ed.scrollTop += __anchorTop() - ed.getBoundingClientRect().top - ${offset};
  return true;
})()`;
