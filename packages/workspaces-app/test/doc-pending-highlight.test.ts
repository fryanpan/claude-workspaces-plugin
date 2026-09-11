import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';

/**
 * The selected words stay marked while the comment on them is written.
 *
 * The owner, on a doc comment from a phone (2026-09-11): "the area we're
 * commenting on does get scrolled up into view properly, but it's no longer
 * highlighted, so I can't tell what I had selected for commenting." The
 * selection is gone because the composer took the caret, so what keeps the
 * words marked cannot be the selection — the surface is asked to hold a mark
 * of its own for as long as the box is open.
 *
 * Driven through the shipped chrome: the composer's open and hide are the two
 * moments the mark is about, and both live in `doc/review-composer.ts`.
 */

/** The shipped shell's body, minus the script that would fetch the bundle. */
const SHELL = (() => {
  const html = readFileSync(resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('>', html.indexOf('<body')) + 1;
  return html.slice(start, html.indexOf('</body>')).replace(/<script\b[\s\S]*?<\/script>/g, '');
})();

const SELECTION = {
  start: new Uint8Array([1]),
  end: new Uint8Array([2]),
  snippet: 'the ferry leaves from the north pier',
};

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
});

function mount(): {
  chrome: ReturnType<typeof mountReviewChrome>;
  marks: Array<{ from: number; to: number } | null>;
  resolved: number;
} {
  document.body.innerHTML = SHELL;
  const marks: Array<{ from: number; to: number } | null> = [];
  const counter = { resolved: 0 };
  const surface: ReviewSurface = {
    getSelectionRel: () => null,
    resolveRel: () => {
      counter.resolved += 1;
      return { from: 7, to: 12 };
    },
    scrollToPos: () => {},
    pulseRange: () => {},
    setThreadRanges: () => {},
    markPending: (range) => marks.push(range),
    destroy: () => {},
  };
  const scope = new MountScope();
  const opts: ChromeOpts = {
    docId: 'd-pending',
    user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
    ydoc: new Y.Doc(),
    surface,
    whenSynced: (cb) => cb(),
    canWrite: true,
    selectHint: 'Select some text first',
    reanchorHint: '',
    getSelection: () => SELECTION,
    scope,
  };
  const chrome = mountReviewChrome(opts);
  open.push(() => scope.dispose());
  return {
    chrome,
    marks,
    get resolved() {
      return counter.resolved;
    },
  };
}

describe('the words a comment is being written about', () => {
  it('are marked when the composer opens, from the anchor it captured', () => {
    const m = mount();
    expect(m.marks, 'CONTROL: nothing is marked before the box opens').toEqual([]);
    m.chrome.openComposer();
    expect(m.resolved, 'the mark comes from the captured anchor, not the live selection').toBe(1);
    expect(m.marks).toEqual([{ from: 7, to: 12 }]);
  });

  it('are let go when the composer closes', () => {
    const m = mount();
    m.chrome.openComposer();
    expect(m.marks.at(-1), 'CONTROL: the mark was on').not.toBeNull();
    m.chrome.hideComposer();
    expect(m.marks.at(-1)).toBeNull();
  });

  it('are let go when the scrim is tapped, the way a reader dismisses it', () => {
    const m = mount();
    m.chrome.openComposer();
    (document.getElementById('composer-scrim') as HTMLElement).click();
    expect(m.marks.at(-1)).toBeNull();
  });
});
