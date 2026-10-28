import { prose } from '@claude-workspaces/core';
import { imageVersionsMap } from '@claude-workspaces/core/image-versions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { docAssetsBase, fromDisplaySrc, toDisplaySrc } from '../src/doc-image-src.ts';
import { paintProse } from '../src/doc/prose-paint.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * An image overwritten beside a bound doc is asked for at a new address, in a
 * page that already has the doc open, and the `.md` keeps the path as written.
 */
const BASE = docAssetsBase('harborlight', 'ws-1');
const SHOWN = '/workspaces/ws-1/docs/harborlight/assets/img/chart.png';

function docWithImage(): Y.Doc {
  const ydoc = new Y.Doc();
  prose
    .getProseFragment(ydoc)
    .push(prose.parseMarkdownBlocks('Riverbend\n\n![caption](img/chart.png)\n'));
  return ydoc;
}

describe('toDisplaySrc with a version', () => {
  it('adds the version, and the address pastes back as the path as written', () => {
    const shown = toDisplaySrc('img/a b.png', BASE, 1700000000123.5);
    expect(shown).toBe(`${BASE}img/a%20b.png?v=1700000000123.5`);
    expect(fromDisplaySrc(shown, BASE)).toBe('img/a b.png');
  });
});

describe('in the editor', () => {
  const open: Array<{ handle: EditorHandle; parent: HTMLElement }> = [];
  beforeEach(() => {
    window.history.replaceState(null, '', '/workspaces/ws-1/docs/harborlight');
  });
  afterEach(() => {
    for (const o of open.splice(0)) {
      o.handle.destroy();
      o.parent.remove();
    }
  });

  const mount = (ydoc: Y.Doc) => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = createEditor({
      parent,
      ydoc,
      awareness: new Awareness(ydoc),
      imageDocId: 'harborlight',
    });
    open.push({ handle, parent });
    const img = parent.querySelector('img');
    if (!img) throw new Error('no image rendered');
    return { handle, img };
  };

  it('renders the recorded version and follows a new one without a re-render', () => {
    const ydoc = docWithImage();
    imageVersionsMap(ydoc).set('img/chart.png', 100);
    const { img } = mount(ydoc);
    expect(img.getAttribute('src')).toBe(`${SHOWN}?v=100`);

    // The server's sweep saw the overwrite.
    imageVersionsMap(ydoc).set('img/chart.png', 250);
    expect(img.getAttribute('src')).toBe(`${SHOWN}?v=250`);

    const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
    expect(md).toContain('![caption](img/chart.png)');
    expect(md).not.toContain('?v=');
  });

  it('a version that arrives after the first render reaches the image', () => {
    const ydoc = docWithImage();
    const { img } = mount(ydoc);
    expect(img.getAttribute('src')).toBe(SHOWN);
    imageVersionsMap(ydoc).set('img/chart.png', 7);
    expect(img.getAttribute('src')).toBe(`${SHOWN}?v=7`);
  });
});

describe('in the first paint', () => {
  it('draws the version and follows a new one', () => {
    window.history.replaceState(null, '', '/workspaces/ws-1/docs/harborlight');
    const ydoc = docWithImage();
    imageVersionsMap(ydoc).set('img/chart.png', 100);
    const parent = document.createElement('div');
    const scope = new MountScope();
    const root = paintProse({ docId: 'harborlight', ydoc, parent, scope });
    const img = () => root.querySelector('img')?.getAttribute('src');
    expect(img()).toBe(`${SHOWN}?v=100`);
    imageVersionsMap(ydoc).set('img/chart.png', 250);
    expect(img()).toBe(`${SHOWN}?v=250`);
    scope.dispose();
  });
});
