import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * A doc opens at its first line.
 *
 * The heading rules give every heading a leading margin so a section breathes
 * away from the block above it — but the FIRST block of a document has no
 * block above it, so that margin is blank page at the top of the scroller.
 * `h1` had a `:first-child` arm from the start; `h2` and `h3` did not, and a
 * fresh meeting doc opens under `## Meeting notes` (the canonical heading in
 * `packages/server/src/notes-section.ts`, written by the notes composer's
 * first tick). So the first line of every meeting doc started 37px down a
 * blank page — the wasted space at the top of a doc Bryan called out on
 * 2026-09-06, on an iPad where height is the scarce axis.
 *
 * Read off the cascade rather than the source: happy-dom resolves
 * `:first-child` and relative lengths, so these are the values the browser
 * computes for the elements the editor actually renders.
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('styles.css', 'doc.css');
  setViewport(IPAD);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/**
 * The doc surface as the editor renders it: `#editor > .ProseMirror`, holding
 * one top-level block per markdown block. Returns the block at `index`.
 */
function docOpening(tags: string[], index: number): HTMLElement {
  const editor = document.createElement('div');
  editor.id = 'editor';
  const pm = document.createElement('div');
  pm.className = 'ProseMirror';
  for (const tag of tags) pm.appendChild(document.createElement(tag));
  editor.appendChild(pm);
  document.body.appendChild(editor);
  return pm.children[index] as HTMLElement;
}

/** `margin-top` in px, whatever unit the rule was written in. */
function marginTopPx(el: HTMLElement): number {
  const style = styleOf(el);
  const raw = style.marginTop;
  if (raw.endsWith('px')) return Number.parseFloat(raw);
  if (raw.endsWith('em')) return Number.parseFloat(raw) * Number.parseFloat(style.fontSize);
  throw new Error(`margin-top came back as "${raw}" — neither px nor em`);
}

describe('the first line of a doc sits at the top', () => {
  it('a meeting doc opening at its "## Meeting notes" heading loses the leading margin', () => {
    // The shape of a fresh meeting doc: the notes heading, then the meeting's
    // first topic, then its bullets.
    const heading = docOpening(['h2', 'h3', 'ul'], 0);
    expect(marginTopPx(heading)).toBeLessThan(8);
  });

  it('holds at phone width too', () => {
    setViewport(PHONE);
    expect(marginTopPx(docOpening(['h2', 'h3', 'ul'], 0))).toBeLessThan(8);
  });

  it('every heading level opens a doc the same way', () => {
    for (const tag of ['h1', 'h2', 'h3']) {
      expect(marginTopPx(docOpening([tag, 'p'], 0))).toBeLessThan(8);
    }
  });

  /**
   * The control. A heading that is NOT the doc's first block keeps its full
   * separating margin — without this the fix could be "delete the margin" and
   * every section in the doc would run into the paragraph above it.
   */
  it('a heading further down the doc keeps its separating margin', () => {
    for (const [tag, index] of [
      ['h2', 2],
      ['h3', 2],
    ] as const) {
      const later = docOpening(['h2', 'p', tag, 'p'], index);
      expect(marginTopPx(later)).toBeGreaterThan(16);
    }
  });
});
