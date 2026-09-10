import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  type ComposerSlot,
  composerSlot,
  keyboardClearDelta,
  marginComposerSlot,
} from '../src/doc/composer-slot.ts';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * WHERE the new-comment composer opens (`doc/composer-slot.ts`).
 *
 * Bryan asked for the box to arrive in the margin, level with the sentence,
 * "rather than moving to bottom of page (Fitt's law)" — and for the bottom
 * sheet that remains on a phone to start as one line. Both are checked by
 * driving the real chrome and reading what the cascade computes, never by
 * looking for a selector in a stylesheet.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

function mountChromeDom(): void {
  document.body.innerHTML = `
    <div id="shell">
      <main id="main">
        <section id="editor-pane"><div id="editor"></div></section>
        <aside id="threads-pane">
          <div class="threads-tabs">
            <button class="tab active" data-tab="open">Open</button>
          </div>
          <ol id="threads-list"></ol>
        </aside>
      </main>
      <button id="toggle-threads">☰</button>
      <span id="threads-count"></span>
      <button id="close-threads">×</button>
      <div id="threads-scrim"></div>
      <div id="doc-title"></div>
      <div id="composer" class="hidden">
        <div id="composer-quote" class="composer-quote"></div>
        <div class="composer-inner">
          <div id="composer-avatar" class="composer-avatar"></div>
          <textarea id="composer-text" rows="1"
            placeholder="Comment, or ask for research, edits, or a task…"></textarea>
          <button id="composer-submit" class="submit-arrow">↑</button>
        </div>
      </div>
      <div id="composer-scrim" class="composer-scrim hidden"></div>
      <div id="thread-view" class="hidden">
        <button id="thread-view-close">×</button>
        <div id="thread-view-body"></div>
        <textarea id="thread-view-reply-text"></textarea>
        <button id="thread-view-reply-submit">Reply</button>
      </div>
      <div id="toast" class="hidden"></div>
    </div>`;
}

/**
 * The box a reader actually types a comment into on a doc. `md-composer.ts`
 * puts a `.md-composer-surface` beside the textarea and Tiptap renders the
 * empty paragraph that carries the placeholder; the textarea stays as the
 * form value. Both halves of the min-height rules name both elements, but
 * only this half can be read here: happy-dom does not implement
 * `:placeholder-shown` (probed directly — `matches()` says false while a
 * control property on the very same rule computes), so the textarea half is
 * checked in the browser instead. Two-line hints and the clipping they cause
 * are why these rules exist; see the PR body for the measurements.
 */
function emptyMarkdownParagraph(): HTMLElement {
  const ta = document.getElementById('composer-text') as HTMLTextAreaElement;
  const wrap = document.createElement('div');
  wrap.className = 'md-composer md-composer-live';
  ta.replaceWith(wrap);
  wrap.innerHTML =
    '<div class="md-composer-surface"><div class="ProseMirror">' +
    '<p class="is-editor-empty"><br></p></div></div>';
  wrap.prepend(ta);
  return wrap.querySelector('p.is-editor-empty') as HTMLElement;
}

/**
 * How many lines of the reader's own text the empty box reserves — the number
 * the two min-height rules are arguing about. Read as a ratio of the box's
 * own font size rather than a px literal, so it does not move when the type
 * scale does.
 */
function reservedLines(el: HTMLElement): number {
  const st = styleOf(el);
  return (
    Number.parseFloat(st.getPropertyValue('min-height')) /
    Number.parseFloat(st.getPropertyValue('font-size'))
  );
}

function fakeSurface(): ReviewSurface {
  return {
    getSelectionRel: () => null,
    resolveRel: () => null,
    scrollToPos: () => {},
    pulseRange: () => {},
    setThreadRanges: () => {},
    destroy: () => {},
  };
}

function chromeOpts(extra?: Partial<ChromeOpts>): ChromeOpts {
  const scope = new MountScope();
  cleanups.push(() => scope.dispose());
  return {
    docId: 'd1',
    user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
    ydoc: new Y.Doc(),
    surface: fakeSurface(),
    whenSynced: (cb) => cb(),
    canWrite: true,
    selectHint: 'Select some text first',
    reanchorHint: '',
    getSelection: () => ({
      start: new Uint8Array([1]),
      end: new Uint8Array([2]),
      snippet: 'the anchored words',
    }),
    scope,
    ...extra,
  };
}

const composerEl = () => document.getElementById('composer') as HTMLElement;
const scrimEl = () => document.getElementById('composer-scrim') as HTMLElement;

describe('the slot in the margin', () => {
  const base = {
    column: { left: 900, width: 260 },
    bounds: { top: 100, bottom: 800 },
    height: 120,
  };

  it('sits level with the sentence, in the column’s own track', () => {
    const slot = composerSlot({ ...base, anchorTop: 300 });
    expect(slot).toEqual<ComposerSlot>({ top: 300, left: 900, width: 260 });
  });

  it('is pulled up when the sentence is near the bottom of the fold', () => {
    // 780 + 120 tall would end 100px below the visible band.
    const slot = composerSlot({ ...base, anchorTop: 780 });
    expect(slot.top).toBe(800 - 120 - 8);
  });

  it('is pushed down when the sentence is above the top of the fold', () => {
    const slot = composerSlot({ ...base, anchorTop: 20 });
    expect(slot.top).toBe(108);
  });

  it('pins to the top rather than off-screen when the band is too short', () => {
    const slot = composerSlot({ ...base, bounds: { top: 100, bottom: 180 }, anchorTop: 150 });
    expect(slot.top).toBe(108);
  });
});

describe('asking for the slot', () => {
  /**
   * happy-dom has no layout engine: every `getBoundingClientRect` is all
   * zeroes and every `offsetHeight` is 0. A fixture that does not say what
   * its boxes are therefore trips `marginComposerSlot`'s zero-width guard
   * before any of the reading it exists to do has happened — which is how
   * the first version of this block passed with the whole try/catch deleted.
   * So the boxes are stated here.
   */
  function boxed(el: HTMLElement, box: { left: number; width: number }): HTMLElement {
    el.getBoundingClientRect = () =>
      ({
        left: box.left,
        right: box.left + box.width,
        width: box.width,
        top: 0,
        bottom: 0,
        height: 0,
        x: box.left,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    return el;
  }

  function reader(opts: {
    marginVisible: boolean;
    column: { left: number; width: number } | null;
    composerHeight?: number;
    scroller?: { top: number; bottom: number };
  }) {
    document.body.innerHTML = '<div id="editor"></div><div id="composer"></div>';
    const editorMount = document.getElementById('editor') as HTMLElement;
    const band = opts.scroller ?? { top: 100, bottom: 800 };
    editorMount.getBoundingClientRect = () =>
      ({ top: band.top, bottom: band.bottom, height: band.bottom - band.top }) as DOMRect;
    if (opts.column) {
      const col = document.createElement('div');
      col.className = 'markup-margin';
      editorMount.appendChild(boxed(col, opts.column));
    }
    const composer = document.getElementById('composer') as HTMLElement;
    Object.defineProperty(composer, 'offsetHeight', { value: opts.composerHeight ?? 60 });
    return {
      editorMount,
      composer,
      marginVisible: () => opts.marginVisible,
      // No keyboard: the band is the scroller's own box.
      visualViewport: { offsetTop: 0, height: 2000 },
    };
  }

  /** An editor whose selection ProseMirror can place, 250px down the page. */
  const placeable = {
    editor: {
      view: {
        state: { selection: { from: 4 } },
        coordsAtPos: () => ({ top: 250, bottom: 268, left: 0, right: 0 }),
      },
    },
  } as never;

  it('hands back the column’s own track, level with the sentence', () => {
    const r = reader({ marginVisible: true, column: { left: 900, width: 260 } });
    expect(marginComposerSlot({ ...r, editor: placeable })).toEqual<ComposerSlot>({
      top: 250,
      left: 900,
      width: 260,
    });
  });

  it('keeps the box out of the on-screen keyboard’s band', () => {
    // The sentence sits at 700, which the layout box (bottom 800) has room
    // for. The visual viewport says the reader can only see down to 420 —
    // what an iPad keyboard does — so the box has to come up to 352 to stay
    // whole and on screen.
    const r = reader({
      marginVisible: true,
      column: { left: 900, width: 260 },
      composerHeight: 60,
      scroller: { top: 100, bottom: 800 },
    });
    const lowDown = {
      editor: {
        view: {
          state: { selection: { from: 4 } },
          coordsAtPos: () => ({ top: 700, bottom: 718, left: 0, right: 0 }),
        },
      },
    } as never;
    expect(
      marginComposerSlot({ ...r, editor: lowDown, visualViewport: { offsetTop: 0, height: 2000 } })
        ?.top,
    ).toBe(700);
    expect(
      marginComposerSlot({ ...r, editor: lowDown, visualViewport: { offsetTop: 0, height: 420 } })
        ?.top,
    ).toBe(420 - 60 - 8);
  });

  it('declines when the reader’s cards are not in the margin', () => {
    const r = reader({ marginVisible: false, column: { left: 900, width: 260 } });
    expect(marginComposerSlot({ ...r, editor: placeable })).toBeNull();
  });

  it('declines when no column has been rendered', () => {
    const r = reader({ marginVisible: true, column: null });
    expect(marginComposerSlot({ ...r, editor: placeable })).toBeNull();
  });

  it('declines when the column is collapsed to nothing', () => {
    const r = reader({ marginVisible: true, column: { left: 900, width: 0 } });
    expect(marginComposerSlot({ ...r, editor: placeable })).toBeNull();
  });

  it('declines when ProseMirror cannot place the selection', () => {
    const r = reader({ marginVisible: true, column: { left: 900, width: 260 } });
    const throwing = {
      editor: {
        view: {
          state: { selection: { from: 4 } },
          coordsAtPos: () => {
            throw new Error('not rendered');
          },
        },
      },
    } as never;
    expect(marginComposerSlot({ ...r, editor: throwing })).toBeNull();
  });
});

describe('opening the composer', () => {
  it('puts it in the margin when the surface names a slot', () => {
    mountChromeDom();
    const chrome = mountReviewChrome(
      chromeOpts({ placeComposer: () => ({ top: 312, left: 904, width: 260 }) }),
    );
    chrome.openComposer();
    const box = composerEl();
    expect(box.classList.contains('composer--margin')).toBe(true);
    expect(box.style.top).toBe('312px');
    expect(box.style.left).toBe('904px');
    expect(box.style.width).toBe('260px');
    // The doc is not dimmed while the box sits beside it.
    expect(scrimEl().classList.contains('composer-scrim--clear')).toBe(true);
  });

  it('leaves it as the bottom sheet when the surface names none', () => {
    mountChromeDom();
    const chrome = mountReviewChrome(chromeOpts());
    chrome.openComposer();
    const box = composerEl();
    expect(box.classList.contains('composer--margin')).toBe(false);
    expect(box.style.top).toBe('');
    expect(scrimEl().classList.contains('composer-scrim--clear')).toBe(false);
  });

  it('becomes a margin box when a window widened past the breakpoint is resized', () => {
    // Rotating an iPad while the box is open. `balloonMarginVisible` answers
    // yes where it answered no a moment ago, and an open sheet has to be able
    // to move into the margin rather than staying a sheet until it is closed.
    mountChromeDom();
    let slot: ComposerSlot | null = null;
    const chrome = mountReviewChrome(chromeOpts({ placeComposer: () => slot }));
    chrome.openComposer();
    expect(composerEl().classList.contains('composer--margin')).toBe(false);

    slot = { top: 200, left: 904, width: 260 };
    window.dispatchEvent(new Event('resize'));
    expect(composerEl().classList.contains('composer--margin')).toBe(true);
    expect(composerEl().style.top).toBe('200px');
  });

  it('leaves a closed composer alone when the window is resized', () => {
    // The control for the row above: `#composer` keeps `display: block` while
    // hidden, so placing one would leave a margin-sized box reporting a rect
    // in the middle of a screen nobody has opened a composer on.
    mountChromeDom();
    const chrome = mountReviewChrome(
      chromeOpts({ placeComposer: () => ({ top: 200, left: 904, width: 260 }) }),
    );
    chrome.openComposer();
    chrome.hideComposer();
    window.dispatchEvent(new Event('resize'));
    expect(composerEl().classList.contains('composer--margin')).toBe(false);
    expect(composerEl().style.top).toBe('');
  });

  it('goes back to the sheet on the next open once the margin is gone', () => {
    mountChromeDom();
    let slot: ComposerSlot | null = { top: 312, left: 904, width: 260 };
    const chrome = mountReviewChrome(chromeOpts({ placeComposer: () => slot }));
    chrome.openComposer();
    chrome.hideComposer();
    slot = null;
    chrome.openComposer();
    expect(composerEl().classList.contains('composer--margin')).toBe(false);
    expect(composerEl().style.width).toBe('');
  });
});

describe('what the cascade does with the placement', () => {
  it('at 1180x820 a margin composer answers to its own geometry, not the sheet’s', () => {
    setViewport(IPAD);
    cleanups.push(installSheets('styles.css', 'doc.css'));
    mountChromeDom();
    const box = composerEl();
    box.classList.remove('hidden');
    const sheet = styleOf(box);
    // The sheet is pinned to the bottom and slides up from off-screen.
    expect(sheet.getPropertyValue('right')).toBe('12px');
    expect(sheet.getPropertyValue('transform')).toBe('translateY(0)');

    box.classList.add('composer--margin');
    const margin = styleOf(box);
    expect(margin.getPropertyValue('right')).toBe('auto');
    expect(margin.getPropertyValue('bottom')).toBe('auto');
    expect(margin.getPropertyValue('transform')).toBe('none');
    expect(margin.getPropertyValue('max-width')).toBe('none');
    // The quote's own `display` is out of reach here: happy-dom matches
    // `.composer-quote:empty` against a filled element, so every reading of
    // it is `none` whatever the width. It is read in the browser instead
    // (`bun run ui:shot`, 1180x820 and 430) — see the PR body.
  });

  it('at 1180x820 a cleared scrim stops dimming the doc', () => {
    setViewport(IPAD);
    cleanups.push(installSheets('styles.css', 'doc.css'));
    mountChromeDom();
    document.body.classList.add('composer-open');
    cleanups.push(() => document.body.classList.remove('composer-open'));
    const scrim = scrimEl();
    scrim.classList.remove('hidden');
    const dimmed = styleOf(scrim).getPropertyValue('background-color');
    scrim.classList.add('composer-scrim--clear');
    const clear = styleOf(scrim).getPropertyValue('background-color');
    expect(dimmed).not.toBe(clear);
    expect(clear).toBe('transparent');
  });

  it('at 430 the sheet opens as one line — the avatar goes', () => {
    setViewport(PHONE);
    cleanups.push(installSheets('styles.css', 'doc.css'));
    mountChromeDom();
    composerEl().classList.remove('hidden');
    expect(styleOf(document.getElementById('composer-avatar') as HTMLElement).display).toBe('none');
    // Positive control: the box the reader types into is still on screen.
    expect(styleOf(document.getElementById('composer-text') as HTMLElement).display).not.toBe(
      'none',
    );
  });

  it('at 430 the empty sheet is one line high, not the two styles.css reserves', () => {
    setViewport(PHONE);
    cleanups.push(installSheets('styles.css', 'doc.css'));
    mountChromeDom();
    composerEl().classList.remove('hidden');
    // No reserved second line: the box is as tall as the one line in it.
    expect(reservedLines(emptyMarkdownParagraph())).toBe(0);
  });

  it('below 430 the empty sheet keeps the two lines, because the hint wraps there', () => {
    // The narrowest phones lose the bet the row above wins: 375px of screen
    // cannot hold the hint on one line, and a wrapped hint is CLIPPED.
    setViewport({ width: 375, height: 812 });
    cleanups.push(installSheets('styles.css', 'doc.css'));
    mountChromeDom();
    composerEl().classList.remove('hidden');
    expect(reservedLines(emptyMarkdownParagraph())).toBeGreaterThan(1);
  });

  it('at 430 the CODE surface keeps its quote and avatar — the sheet is scoped to markdown', () => {
    // index.html is the shell for all three surfaces, and only the markdown
    // one scrolls the sentence clear of the keyboard. On the code surface the
    // quote is the only sign of which line is being commented.
    setViewport(PHONE);
    cleanups.push(installSheets('styles.css', 'doc.css'));
    mountChromeDom();
    document.body.classList.add('code-mode');
    cleanups.push(() => document.body.classList.remove('code-mode'));
    composerEl().classList.remove('hidden');
    expect(styleOf(document.getElementById('composer-avatar') as HTMLElement).display).toBe('flex');
    expect(reservedLines(emptyMarkdownParagraph())).toBeGreaterThan(1);
  });

  it('at 1180x820 the sheet keeps its avatar — the width control for the row above', () => {
    setViewport(IPAD);
    cleanups.push(installSheets('styles.css', 'doc.css'));
    mountChromeDom();
    composerEl().classList.remove('hidden');
    expect(styleOf(document.getElementById('composer-avatar') as HTMLElement).display).toBe('flex');
  });
});

describe('clearing the keyboard', () => {
  // Bryan asked for the commented text to sit "a few lines above the comment
  // prompt" once the phone keyboard is up. The reference point is the box, so
  // the answer follows the keyboard rather than a fraction of the screen.
  const sentence = { selTop: 600, selBottom: 620, bandTop: 0 };

  it('lifts the sentence to a few lines above the composer', () => {
    // Composer top 500, 20px lines: the sentence should end at 500 - 3*20.
    const delta = keyboardClearDelta({ ...sentence, composerTop: 500 });
    expect(sentence.selBottom - delta).toBe(440);
  });

  it('scrolls the other way when the sentence is already above the gap', () => {
    const delta = keyboardClearDelta({ ...sentence, composerTop: 900 });
    expect(delta).toBeLessThan(0);
    expect(sentence.selBottom - delta).toBe(840);
  });

  it('never pushes the sentence off the top of the visible band', () => {
    // A short composer over a sentence near the top: clearing it fully would
    // scroll the words being commented on off the screen.
    const delta = keyboardClearDelta({
      selTop: 100,
      selBottom: 120,
      bandTop: 50,
      composerTop: 100,
    });
    expect(100 - delta).toBe(50);
  });

  it('stays still when the sentence is already where it belongs', () => {
    const delta = keyboardClearDelta({ ...sentence, composerTop: 682 });
    expect(delta).toBe(0);
  });
});
