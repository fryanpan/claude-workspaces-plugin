import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as realChunk from '../src/md-composer-chunk.ts';
import {
  attachMarkdownComposer,
  composerSelection,
  destroyLiveComposers,
  setComposerEditorLoader,
} from '../src/md-composer.ts';
import { surfaceOf } from './support/composer.ts';

/**
 * Select All in a reply box selects the reply, not the doc around it.
 *
 * On a phone a thread's card is a widget decoration INSIDE the doc's editing
 * host, so its reply box is an editable nested in another one, with the
 * card's `contenteditable=false` between them. WebKit's native select-all —
 * what iOS's Select All menu runs, with no keydown for Tiptap's Mod-a to
 * catch — widens to the highest editable ancestor and took the whole doc
 * (Bryan, 29 Oct). Measured in a WKWebView: `execCommand('selectAll')` with
 * the caret in the nested box selected all three blocks of the outer host,
 * and fired one cancellable `selectstart` whose target was that outer host.
 * These tests replay that event, since happy-dom has no native select-all.
 */

const COMMENT = 'inner comment text';

let host: HTMLElement;
let ta: HTMLTextAreaElement;

function caretIn(el: Node, offset = 2): void {
  const range = document.createRange();
  range.setStart(el, offset);
  range.collapse(true);
  const sel = document.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** What WebKit dispatches before a native select-all: `selectstart` aimed at
 *  the highest editable root. Returns whether the select-all may proceed. */
function nativeSelectAll(target: Node): boolean {
  return target.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true }));
}

function composerText(): Text {
  const p = surfaceOf(ta)?.querySelector('.ProseMirror p');
  const text = p?.firstChild;
  if (!(text instanceof Text)) throw new Error('composer has no text node');
  return text;
}

beforeEach(() => {
  setComposerEditorLoader(() => realChunk);
  document.body.replaceChildren();
  // The doc's editing host, with one block of prose either side of a card.
  host = document.createElement('div');
  host.contentEditable = 'true';
  host.innerHTML = '<p id="before">Outer doc paragraph one.</p>';
  const card = document.createElement('div');
  card.contentEditable = 'false';
  ta = document.createElement('textarea');
  ta.value = COMMENT;
  card.append(ta);
  const after = document.createElement('p');
  after.textContent = 'Outer doc paragraph two.';
  host.append(card, after);
  document.body.append(host);
  attachMarkdownComposer(ta);
});

afterEach(() => {
  destroyLiveComposers();
});

describe('Select All from a reply box inside the doc', () => {
  it('is refused for the doc and selects the whole reply instead', () => {
    caretIn(composerText());
    expect(nativeSelectAll(host)).toBe(false);
    const sel = composerSelection(ta);
    // An AllSelection over one paragraph: from the doc start to its end.
    expect(sel).toEqual({ from: 0, to: COMMENT.length + 2 });
  });

  it('leaves a selection the reader starts inside the box alone', () => {
    caretIn(composerText());
    expect(nativeSelectAll(composerText())).toBe(true);
  });

  it('still selects the doc when the caret is in the doc', () => {
    const prose = document.getElementById('before')?.firstChild;
    if (!prose) throw new Error('no prose');
    caretIn(prose);
    expect(nativeSelectAll(host)).toBe(true);
  });

  it('stops listening once the box is gone', () => {
    caretIn(composerText());
    destroyLiveComposers();
    expect(nativeSelectAll(host)).toBe(true);
  });
});
