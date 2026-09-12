import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { wireThreadRangeClicks } from '../src/doc/chrome-panels.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome } from '../src/review-chrome.ts';

/**
 * Clicking a comment's highlight leaves the caret where the finger landed.
 *
 * The doc is editable for everyone who can write it now, so a click on a
 * highlighted phrase does two things at once: it opens the thread AND it puts
 * a caret in the prose. Those two used to fight. The browser reports a new
 * caret to the editor asynchronously — well after the click handler returns —
 * while the handler repaints the highlight synchronously, and a repaint writes
 * the editor's own selection back to the DOM. So the editor's PREVIOUS
 * selection won, and on a freshly opened doc that is position one: inside the
 * title. The reader tapped a sentence, the caret appeared in the heading, the
 * comment pill followed it to the top of the window, and the next keystroke
 * was typed into the doc's name and saved there.
 *
 * These drive the real editor, with the real click wiring and the real
 * decoration, and then TYPE — because the bug was only ever visible in where
 * the next keystroke landed.
 *
 * The one thing no headless DOM can supply is the coordinate-to-position
 * mapping: happy-dom lays nothing out, so `posAtCoords` has no geometry to
 * answer from. It is stubbed to answer the position under the click, which is
 * exactly what a browser answers; everything either side of it is the shipping
 * code. The measured browser numbers are in the PR body.
 *
 * All fixtures synthetic: Riverbend and Harborlight are place names.
 */

const TITLE = 'Riverbend permit review';
const BODY = 'Three applicants waited on the same clerk this quarter.';
/** The word the comment is about, and the word the reader taps. */
const ANCHOR = 'waited';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f();
  document.body.innerHTML = '';
});

/** The chrome shell the review chrome expects to find already in the page. */
function mountChromeDom(): void {
  document.body.innerHTML = `
    <div id="shell">
      <main id="editor-pane"><div id="editor"></div></main>
      <aside id="threads-pane">
        <div class="threads-tabs">
          <button class="tab active" data-tab="open">Open</button>
          <button class="tab" data-tab="resolved">Resolved</button>
        </div>
        <button id="toggle-threads">☰</button>
        <span id="threads-count"></span>
        <button id="close-threads">×</button>
        <ol id="threads-list"></ol>
      </aside>
      <div id="threads-scrim"></div>
      <div id="doc-title"></div>
      <div id="composer" class="hidden">
        <div id="composer-avatar"></div>
        <div id="composer-quote"></div>
        <textarea id="composer-text"></textarea>
        <button id="composer-submit">Post</button>
      </div>
      <div id="composer-scrim" class="hidden"></div>
      <div id="thread-view" class="hidden">
        <button id="thread-view-close">×</button>
        <div id="thread-view-body"></div>
        <textarea id="thread-view-reply-text"></textarea>
        <button id="thread-view-reply-submit">Reply</button>
      </div>
      <div id="toast" class="hidden"></div>
    </div>`;
}

/** Where a phrase starts in the editor's own position space. */
function posOf(editor: EditorHandle, phrase: string): number {
  let at = -1;
  editor.editor.state.doc.descendants((node, pos) => {
    if (at >= 0) return false;
    const text = node.isText ? (node.text ?? '') : '';
    const i = text.indexOf(phrase);
    if (i >= 0) at = pos + i;
    return at < 0;
  });
  if (at < 0) throw new Error(`"${phrase}" is not in the doc`);
  return at;
}

interface Mounted {
  editor: EditorHandle;
  /** The position the stubbed pointer lands on. */
  clickPos: number;
  span: () => HTMLElement;
  h1Text: () => string;
  bodyText: () => string;
}

function mount(): Mounted {
  mountChromeDom();
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(`# ${TITLE}\n\n${BODY}`));
  const editorMount = document.getElementById('editor') as HTMLElement;
  const editor = createEditor({
    parent: editorMount,
    ydoc,
    awareness: new Awareness(ydoc),
    // The state the doc is in for everyone who can write it.
    editable: true,
  });
  cleanups.push(() => editor.destroy());

  const from = posOf(editor, ANCHOR);
  const to = from + ANCHOR.length;
  // Two characters into the word — a tap lands on a letter, not on a boundary.
  const clickPos = from + 2;
  // The geometry happy-dom cannot have. A browser answers the position under
  // the pointer; so does this.
  editor.editor.view.posAtCoords = () => ({ pos: clickPos, inside: -1 });

  editor.setThreadRanges([{ id: 't1', from, to, status: 'open' }], null);

  const scope = new MountScope();
  cleanups.push(() => scope.dispose());
  const chromeOpts: ChromeOpts = {
    docId: 'd1',
    user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
    ydoc,
    surface: editor,
    whenSynced: (cb) => cb(),
    canWrite: true,
    selectHint: '',
    reanchorHint: '',
    getSelection: () => null,
    scope,
  };
  const chrome = mountReviewChrome(chromeOpts);
  cleanups.push(() => chrome.destroy?.());
  wireThreadRangeClicks({ editorMount, chrome, surface: editor, scope });

  const blocks = () => [...editorMount.querySelectorAll('.ProseMirror > *')];
  return {
    editor,
    clickPos,
    span: () => {
      const el = editorMount.querySelector('.thread-range') as HTMLElement | null;
      if (!el) throw new Error('the editor rendered no highlight to click');
      return el;
    },
    h1Text: () => blocks()[0]?.textContent ?? '',
    bodyText: () => blocks()[1]?.textContent ?? '',
  };
}

function clickHighlight(el: Element): void {
  el.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }),
  );
}

describe('a click on a comment highlight', () => {
  it('leaves the caret on the word that was clicked, not at the top of the doc', () => {
    const m = mount();
    clickHighlight(m.span());
    expect(m.editor.editor.state.selection.from).toBe(m.clickPos);
    expect(m.editor.editor.state.selection.empty).toBe(true);
  });

  it('types the next keystroke where the reader clicked, and never into the title', () => {
    const m = mount();
    const titleBefore = m.h1Text();
    clickHighlight(m.span());
    m.editor.editor.commands.insertContent('MARK');

    // The heading is untouched — this is the whole report: a doc whose name
    // had acquired typed characters, saved to the file behind it.
    expect(m.h1Text()).toBe(titleBefore);
    expect(m.h1Text()).toBe(TITLE);
    // And the characters are in the sentence, inside the word that was
    // clicked, where a caret two letters in puts them.
    expect(m.bodyText()).toBe(BODY.replace('waited', 'waMARKited'));
  });

  it('still opens the thread it was clicked for', () => {
    const m = mount();
    clickHighlight(m.span());
    const shell = document.getElementById('shell') as HTMLElement;
    // The drawer is the desktop route into the thread, and it is the one this
    // mount takes: no balloon margin, not mobile.
    expect(shell.classList.contains('threads-open')).toBe(true);
  });

  /**
   * THE CONTROL for the caret, without deleting the fix.
   *
   * A surface that answers no position is the shape every surface had before
   * this branch — the handler asked nothing and repainted straight away. The
   * caret then stays where the editor already had it, which on a freshly
   * opened doc is inside the title, and the keystroke lands there. If this
   * case ever passes with the same reading as the two above, they have stopped
   * measuring anything.
   */
  it('lands in the title when the surface cannot place a caret — the pre-fix behaviour', () => {
    const m = mount();
    m.editor.editor.view.posAtCoords = () => null;
    clickHighlight(m.span());
    m.editor.editor.commands.insertContent('MARK');
    expect(m.h1Text()).not.toBe(TITLE);
    expect(m.h1Text()).toContain('MARK');
    expect(m.bodyText()).toBe(BODY);
  });
});
