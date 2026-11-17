import { prose } from '@claude-workspaces/core';
import {
  type ComponentHostApi,
  type MountFn,
  jsx,
  render,
} from '@claude-workspaces/core/mdx-component-runtime';
import { componentBuildsMap, componentInputs } from '@claude-workspaces/core/mdx-components';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { setComponentDoc, setComponentLoaderForTest } from '../src/mdx-component.ts';

/**
 * Words a live component drew are commentable, and every page sees every
 * component, read-only pages included.
 *
 * A component draws into the page outside the doc's text, so its words have
 * no doc position. Selecting them anchors the comment to the component tag's
 * source and quotes the selected words (`selection-range.ts`). A read-only
 * page mounts the component too, and follows a rebuild made elsewhere
 * without a reload.
 *
 * Each page is the real editor over its own Y.Doc, wired to a third Y.Doc
 * standing in for the server. The bundle is the runtime's own `render`.
 */

const IMPORT = "import Tide from './components/tide.tsx'";
const TAG = '<Tide label="Riverbend" />';
const DOC = `# Harborlight\n\nThe ferry log.\n\n${IMPORT}\n\n${TAG}\n`;
const KEY = componentInputs([IMPORT, TAG])[0]?.key ?? '';
const FIRST = 'a'.repeat(32);
const SECOND = 'b'.repeat(32);

const open: Array<() => void> = [];
/** Which build each mount drew, so a rebuild can be seen arriving. */
let words: Record<string, string>;

const tideFor =
  (said: string): MountFn =>
  (el) => {
    const p = document.createElement('p');
    p.className = 'tide';
    p.textContent = said;
    el.append(p);
  };

beforeEach(() => {
  history.replaceState(null, '', '/workspaces/w-harbor/docs/d-tide');
  words = { [FIRST]: 'Riverbend high water at noon', [SECOND]: 'Saltmarsh low water at dusk' };
  setComponentLoaderForTest(async (url) => {
    const hash = /([a-f0-9]{32})\.js$/.exec(url)?.[1] ?? '';
    const said = words[hash] ?? 'unknown build';
    return {
      default: (host: HTMLElement, api: ComponentHostApi) =>
        render(host, api, () => jsx(tideFor(said), {})),
    };
  });
});

afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
  setComponentLoaderForTest(null);
});

function serverDoc(): Y.Doc {
  const server = new Y.Doc();
  prose.getProseFragment(server).push(prose.parseMarkdownBlocks(DOC, { mdx: true }));
  componentBuildsMap(server).set(KEY, { hash: FIRST, at: Date.now() });
  return server;
}

function openPage(server: Y.Doc, canWrite = true): { page: HTMLElement; handle: EditorHandle } {
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  const down = (u: Uint8Array, origin: unknown) => {
    if (origin !== client) Y.applyUpdate(client, u, 'server');
  };
  server.on('update', down);
  client.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'server' && canWrite) Y.applyUpdate(server, u, client);
  });
  setComponentDoc(client, true, canWrite);
  const page = document.createElement('div');
  document.body.appendChild(page);
  const handle = createEditor({ parent: page, ydoc: client, awareness: new Awareness(client) });
  if (!canWrite) handle.editor.setEditable(false);
  open.push(() => {
    handle.destroy();
    server.off('update', down);
  });
  return { page, handle };
}

const drawn = (page: HTMLElement) => page.querySelector('.mdx-live .tide')?.textContent ?? '';
const settle = async (until: () => boolean) => {
  for (let i = 0; i < 100 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
};

/** Select `text` inside `node`'s first text child. */
function select(node: Node, text: string, endNode?: Node, endText?: string): void {
  const start = node.firstChild as Text;
  const at = start.data.indexOf(text);
  const range = document.createRange();
  range.setStart(start, at);
  if (endNode && endText !== undefined) {
    const end = endNode.firstChild as Text;
    range.setEnd(end, end.data.indexOf(endText) + endText.length);
  } else {
    range.setEnd(start, at + text.length);
  }
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

describe("a component's drawn words", () => {
  it.each([
    ['an editor', true],
    ['a read-only reader', false],
  ])('anchor %s’s comment to the tag’s source, quoting the words selected', async (_, canWrite) => {
    const server = serverDoc();
    const { page, handle } = openPage(server, canWrite);
    await settle(() => drawn(page) !== '');
    const tide = page.querySelector('.mdx-live .tide');
    if (!tide) throw new Error('the component did not draw');
    select(tide, 'high water');

    const sel = handle.getSelectionRel();
    expect(sel?.snippet).toBe('high water');
    const at = sel ? handle.resolveRel(sel.start, sel.end) : null;
    expect(at).not.toBeNull();
    // The anchor spans the tag's source: the words a reader sees open there.
    expect(handle.editor.state.doc.textBetween(at?.from ?? 0, at?.to ?? 0)).toBe(TAG);
  });

  it('leave a selection reaching out into the prose to the prose', async () => {
    const server = serverDoc();
    const { page, handle } = openPage(server);
    await settle(() => drawn(page) !== '');
    const para = [...page.querySelectorAll('.ProseMirror p')].find(
      (p) => p.textContent === 'The ferry log.',
    );
    const tide = page.querySelector('.mdx-live .tide');
    if (!para || !tide) throw new Error('missing the paragraph or the component');
    select(para, 'ferry', tide, 'Riverbend');
    // Not wholly inside the component, so it is not quoted from it.
    expect(handle.getSelectionRel()?.snippet ?? '').not.toBe('ferry log. Riverbend');
    expect(handle.getSelectionRel()?.snippet ?? '').not.toContain('high water');
  });
});

describe('a read-only page', () => {
  it('mounts every component and follows a rebuild made elsewhere', async () => {
    const server = serverDoc();
    const { page } = openPage(server, false);
    await settle(() => drawn(page) !== '');
    expect(drawn(page)).toBe('Riverbend high water at noon');
    componentBuildsMap(server).set(KEY, { hash: SECOND, at: Date.now() });
    await settle(() => drawn(page) === 'Saltmarsh low water at dusk');
    expect(drawn(page)).toBe('Saltmarsh low water at dusk');
  });
});
