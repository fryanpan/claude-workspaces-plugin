import { prose } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { renderProse } from '../src/doc/prose-paint.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';

/**
 * An image line's display width and trailing footnote, in the editor and in
 * the first paint: the picture draws at the width the markdown gives, the
 * note shows under it, and a person's edit elsewhere in the doc writes the
 * line back unchanged.
 *
 * Fixtures are synthetic. The repo is public.
 */
const LINE = '![Harborlight pier](img/pier.png){width=480}^[Survey photo, 2024.]';

const open: Array<{ handle: EditorHandle; parent: HTMLElement }> = [];
beforeEach(() => window.history.replaceState(null, '', '/workspaces/ws-1/docs/harborlight'));
afterEach(() => {
  for (const o of open.splice(0)) {
    o.handle.destroy();
    o.parent.remove();
  }
});

function fragmentOf(md: string): Y.XmlFragment {
  const fragment = prose.getProseFragment(new Y.Doc());
  fragment.push(prose.parseMarkdownBlocks(md));
  return fragment;
}

function mount(md: string) {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  fragment.push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createEditor({
    parent,
    ydoc,
    awareness: new Awareness(ydoc),
    imageDocId: 'harborlight',
  });
  open.push({ handle, parent });
  return { parent, fragment, handle };
}

describe('a sized image with a footnote, in the editor', () => {
  it('draws the image at its width with the note under it', () => {
    const { parent } = mount(`Riverbend\n\n${LINE}\n`);
    const img = parent.querySelector('img');
    expect(img?.getAttribute('width')).toBe('480');
    expect(img?.hasAttribute('footnotes')).toBe(false);
    expect(parent.querySelector('figcaption')?.textContent).toBe('Survey photo, 2024.');
  });

  it('an image with no note draws a bare img, as before', () => {
    const { parent } = mount('![a](img/a.png){width=320}\n');
    expect(parent.querySelector('figure')).toBeNull();
    expect(parent.querySelector('img')?.getAttribute('width')).toBe('320');
  });

  it('a person’s edit elsewhere writes the line back unchanged', () => {
    const { fragment, handle } = mount(`Riverbend\n\n${LINE}\n`);
    handle.editor.commands.insertContentAt(1, 'Saltmarsh ');
    const md = prose.serializeFragmentToMarkdown(fragment);
    expect(md).toBe(`Saltmarsh Riverbend\n\n${LINE}\n`);
  });
});

describe('a sized image with a footnote, in the first paint', () => {
  it('draws the same width and note the editor does', () => {
    const root = renderProse(fragmentOf(`${LINE}\n`), document, '/assets/');
    expect(root.querySelector('img')?.getAttribute('width')).toBe('480');
    expect(root.querySelector('figcaption')?.textContent).toBe('Survey photo, 2024.');
  });
});
