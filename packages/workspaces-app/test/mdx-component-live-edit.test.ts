import { prose } from '@claude-workspaces/core';
import type { ComponentHostApi } from '@claude-workspaces/core/mdx-component-runtime';
import { componentBuildsMap, componentInputs } from '@claude-workspaces/core/mdx-components';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { setComponentDoc, setComponentLoaderForTest } from '../src/mdx-component.ts';
import { REDRAW_MS } from '../src/mdx-flow-block.ts';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * A component drawn in the editor mounts once and stays mounted while the doc
 * around it changes: typing in prose on this page, a peer typing, splitting
 * and joining paragraphs on another page, an agent inserting blocks over the
 * socket, a peer moving another tag's props. Only its own build moving
 * remounts it: a props edit, typed after Edit, keeps the drawing until the
 * rebuilt bundle lands and then remounts once on every open page. A tag whose
 * import is an `.astro` file keeps the preview.
 *
 * Two real editors on two Y.Docs synced both ways stand in for two pages on
 * one socket; the bundle import is swapped for a module that counts mounts
 * per page.
 */

const IMPORT = "import Ferry from './components/ferry.tsx'";
const TAG = '<Ferry id="ferry" route="Harborlight" />';
const OTHER = '<Ferry route="Saltmarsh" />';
const DOC = `# Riverbend\n\nThe ferry runs hourly.\n\nIt stops at the pier.\n\n${IMPORT}\n\n${TAG}\n\nSailings resume in spring.\n\n${OTHER}\n`;
const keyOf = (tag: string, blocks = [IMPORT, TAG, OTHER]) =>
  componentInputs(blocks).find((i) => i.tag === tag)?.key ?? '';

const HASH_A = 'a'.repeat(32);
const HASH_B = 'b'.repeat(32);

const open: Array<() => void> = [];
/** Each mount as `<page>:<hash>`. */
let mounts: string[] = [];
let cleanups: string[] = [];

beforeEach(() => {
  history.replaceState(null, '', '/workspaces/w-harbor/docs/d-ferry');
  mounts = [];
  cleanups = [];
  setComponentLoaderForTest(async (url) => {
    const hash = /([a-f0-9]{32})\.js$/.exec(url)?.[1] ?? '?';
    return {
      default: (host: HTMLElement, _api: ComponentHostApi) => {
        const page = host.closest<HTMLElement>('[data-page]')?.dataset.page ?? '?';
        mounts.push(`${page}:${hash}`);
        host.textContent = `ferry ${hash.slice(0, 4)}`;
        return () => cleanups.push(`${page}:${hash}`);
      },
    };
  });
});

afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
  setComponentLoaderForTest(null);
});

function page(ydoc: Y.Doc, name: string): EditorHandle {
  setComponentDoc(ydoc, true);
  const parent = document.createElement('div');
  parent.id = 'editor';
  parent.dataset.page = name;
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
  open.push(() => handle.destroy());
  return handle;
}

/** Two pages on one doc, synced both ways as the socket syncs them. */
function twoPages(md = DOC) {
  const mine = new Y.Doc();
  prose.getProseFragment(mine).push(prose.parseMarkdownBlocks(md, { mdx: true }));
  const theirs = new Y.Doc();
  Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine));
  mine.on(
    'update',
    (u: Uint8Array, o: unknown) => o !== 'peer' && Y.applyUpdate(theirs, u, 'peer'),
  );
  theirs.on(
    'update',
    (u: Uint8Array, o: unknown) => o !== 'peer' && Y.applyUpdate(mine, u, 'peer'),
  );
  return { mine, theirs, a: page(mine, 'mine'), b: page(theirs, 'theirs') };
}

const file = (ydoc: Y.Doc, key: string, hash: string) =>
  componentBuildsMap(ydoc).set(key, { hash, at: Date.now() });

const settle = async (until: () => boolean) => {
  for (let i = 0; i < 50 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
};
/** Let every queued microtask and loader promise run out. */
const drain = () => new Promise((r) => setTimeout(r, 20));

function posOf(handle: EditorHandle, text: string): number {
  let at = -1;
  handle.editor.state.doc.descendants((n, pos) => {
    if (at >= 0 || !n.isText) return at < 0;
    const i = (n.text ?? '').indexOf(text);
    if (i >= 0) at = pos + i;
    return false;
  });
  if (at < 0) throw new Error(`no ${text} in the doc`);
  return at;
}

/** Type `text` one character at a time, as a person does. */
function typeAt(handle: EditorHandle, at: number, text: string): void {
  [...text].forEach((ch, i) => {
    const { view } = handle.editor;
    view.dispatch(view.state.tr.insertText(ch, at + i));
  });
}

const md = (ydoc: Y.Doc) => prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));

/** Both pages mounted the tag's first build, once each. */
async function drawn(mine: Y.Doc) {
  file(mine, keyOf(TAG), HASH_A);
  file(mine, keyOf(OTHER), HASH_B);
  await settle(() => mounts.length === 4);
  expect([...mounts].sort()).toEqual(
    [`mine:${HASH_A}`, `mine:${HASH_B}`, `theirs:${HASH_A}`, `theirs:${HASH_B}`].sort(),
  );
  mounts = [];
}

describe('typing elsewhere in the doc remounts no component', () => {
  // The control: the count below sees a remount when one happens. Handing
  // the view its node views again makes ProseMirror rebuild every one.
  it('counts the remounts of node views the editor rebuilds', async () => {
    const { mine, a } = twoPages();
    await drawn(mine);
    const { view } = a.editor;
    const fresh = Object.fromEntries(
      Object.entries(view.props.nodeViews ?? {}).map(([k, f]) => [
        k,
        (...args: Parameters<typeof f>) => f(...args),
      ]),
    );
    view.setProps({ nodeViews: fresh });
    await settle(() => mounts.length === 2);
    expect([...mounts].sort()).toEqual([`mine:${HASH_A}`, `mine:${HASH_B}`]);
  });

  it('when this page types in a paragraph', async () => {
    const { mine, a } = twoPages();
    await drawn(mine);
    typeAt(a, posOf(a, 'hourly'), 'every day, ');
    await drain();
    expect(md(mine)).toContain('runs every day, hourly');
    expect(mounts).toEqual([]);
    expect(cleanups).toEqual([]);
  });

  it('when a peer types in a paragraph beside the tag', async () => {
    const { mine, theirs, b } = twoPages();
    await drawn(mine);
    typeAt(b, posOf(b, 'resume'), 'will ');
    await drain();
    expect(md(mine)).toContain('Sailings will resume');
    expect(md(theirs)).toBe(md(mine));
    expect(mounts).toEqual([]);
    expect(cleanups).toEqual([]);
  });

  it('when a peer splits and joins the paragraph above the tag', async () => {
    const { mine, b } = twoPages();
    await drawn(mine);
    b.editor.chain().setTextSelection(posOf(b, 'pier')).splitBlock().run();
    await drain();
    expect(md(mine)).toContain('It stops at the \n\npier.');
    b.editor.chain().setTextSelection(posOf(b, 'pier')).joinBackward().run();
    await drain();
    expect(md(mine)).toContain('It stops at the pier.');
    expect(mounts).toEqual([]);
    expect(cleanups).toEqual([]);
  });

  it('when a peer deletes the paragraph above the tag', async () => {
    const { mine, b } = twoPages();
    await drawn(mine);
    const from = posOf(b, 'It stops') - 1;
    const to = from + b.editor.state.doc.resolve(from + 1).parent.nodeSize;
    b.editor.chain().deleteRange({ from, to }).run();
    await drain();
    expect(md(mine)).not.toContain('It stops');
    expect(mounts).toEqual([]);
    expect(cleanups).toEqual([]);
  });

  it('when an agent inserts a paragraph and another tag above it over the socket', async () => {
    const { mine, theirs } = twoPages();
    await drawn(mine);
    // What the server's block insert does: new Y elements in the fragment,
    // arriving on both pages as a remote update.
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(theirs));
    const before = Y.encodeStateVector(server);
    prose.getProseFragment(server).insert(
      1,
      prose.parseMarkdownBlocks('A note from Bob.\n\n<Ferry route="Riverbend" />\n', {
        mdx: true,
      }),
    );
    Y.applyUpdate(theirs, Y.encodeStateAsUpdate(server, before), 'socket');
    await drain();
    expect(md(mine)).toContain('A note from Bob.');
    expect(mounts.filter((m) => m.endsWith(HASH_A) || m.endsWith(HASH_B))).toEqual([]);
    expect(cleanups).toEqual([]);
  });

  it('when a peer edits another tag’s props', async () => {
    const { mine, b } = twoPages();
    await drawn(mine);
    const block = b.editor.view.dom.querySelectorAll<HTMLElement>('.mdx-block')[2];
    block?.querySelector<HTMLElement>('.mdx-edit')?.click();
    typeAt(b, posOf(b, 'Saltmarsh'), 'North ');
    await drain();
    expect(md(mine)).toContain('<Ferry route="North Saltmarsh" />');
    expect(mounts).toEqual([]);
    expect(cleanups.filter((c) => c.endsWith(HASH_A))).toEqual([]);
  });
});

const blocks = (h: EditorHandle) => [
  ...h.editor.view.dom.querySelectorAll<HTMLElement>('.mdx-block'),
];
/** The tag's block: the one after the import, whatever its props now say. */
const tagBlock = (h: EditorHandle) =>
  blocks(h).find((b) =>
    b.querySelector('.mdx-source')?.textContent?.startsWith('<Ferry id='),
  ) as HTMLElement;
const liveText = (h: EditorHandle) => tagBlock(h).querySelector('.mdx-live')?.textContent;

describe('the page changing its own editor remounts no component', () => {
  // What the doc page does after the components drew: `doc-gates.ts` sets
  // editability as the page learns who it is talking to, and
  // `agent-focus.ts` adds a plugin.
  it('when editability flips and a plugin is added', async () => {
    const { mine, a } = twoPages();
    await drawn(mine);
    a.editor.setEditable(false);
    a.editor.setEditable(true);
    a.editor.registerPlugin(new Plugin({ key: new PluginKey('riverbend-probe') }));
    await drain();
    expect(mounts).toEqual([]);
    expect(cleanups).toEqual([]);
  });
});

describe('a props edit', () => {
  for (const vp of [IPAD, PHONE]) {
    it(`offers Edit on a component tag at ${vp.width}px, sized as a chart's`, () => {
      setViewport(vp);
      open.push(installSheets('styles.css', 'doc.css'));
      const { a } = twoPages();
      const edit = tagBlock(a).querySelector('.mdx-edit') as HTMLElement;
      const box = () => {
        const st = styleOf(edit);
        return [st.display, st.position, st.top, st.right, st.width, st.height];
      };
      expect(box()).toEqual(['block', 'absolute', '10px', '8px', '64px', '44px']);
      edit.click();
      expect(box()).toEqual(['block', 'absolute', '10px', '8px', '64px', '44px']);
    });
  }

  it('offers no Edit on a component tag to a reader who cannot write', () => {
    open.push(installSheets('styles.css', 'doc.css'));
    const ydoc = new Y.Doc();
    prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(DOC, { mdx: true }));
    setComponentDoc(ydoc, true, false);
    const parent = document.createElement('div');
    parent.id = 'editor';
    document.body.appendChild(parent);
    const h = createEditor({ parent, ydoc, awareness: new Awareness(ydoc), editable: false });
    open.push(() => h.destroy());
    expect(styleOf(tagBlock(h).querySelector('.mdx-edit') as Element).display).toBe('none');
  });

  it('keeps the drawing while it rebuilds, then redraws once on both pages', async () => {
    const { mine, a, b } = twoPages();
    await drawn(mine);
    const edit = tagBlock(a).querySelector('.mdx-edit') as HTMLElement;
    edit.click();
    const at = posOf(a, 'Harborlight');
    const { view } = a.editor;
    view.dispatch(view.state.tr.insertText('Riverbend', at, at + 'Harborlight'.length));
    const edited = TAG.replace('Harborlight', 'Riverbend');
    expect(md(mine)).toContain(edited);
    await new Promise((r) => setTimeout(r, REDRAW_MS + 20));
    // Not built yet: both pages still show the last drawing, with no
    // "Building…" in its place.
    for (const h of [a, b]) {
      expect(liveText(h)).toBe(`ferry ${HASH_A.slice(0, 4)}`);
      expect(tagBlock(h).querySelector<HTMLElement>('.mdx-live-status')?.hidden).toBe(true);
    }
    // The server files the rebuilt tag under its new key and drops the old.
    const HASH_C = 'c'.repeat(32);
    mine.transact(() => {
      componentBuildsMap(mine).delete(keyOf(TAG));
      file(mine, keyOf(edited, [IMPORT, edited, OTHER]), HASH_C);
    });
    await settle(() => mounts.length === 2);
    await drain();
    expect([...mounts].sort()).toEqual([`mine:${HASH_C}`, `theirs:${HASH_C}`]);
    expect([...cleanups].sort()).toEqual([`mine:${HASH_A}`, `theirs:${HASH_A}`]);
    for (const h of [a, b]) expect(liveText(h)).toBe('ferry cccc');
  });
});

describe('an .astro import', () => {
  it('keeps the preview beside a live component', async () => {
    const astro = "import Map from './map.astro'";
    const doc = `# Riverbend\n\n${astro}\n\n${IMPORT}\n\n<Map id="map" zoom={12} />\n\n${TAG}\n`;
    const { mine, a } = twoPages(doc);
    file(mine, keyOf(TAG, [astro, IMPORT, '<Map id="map" zoom={12} />', TAG]), HASH_A);
    await settle(() => mounts.length === 2);
    await drain();
    expect(componentInputs([astro, '<Map id="map" zoom={12} />']).length).toBe(0);
    const map = blocks(a).find((x) =>
      x.querySelector('.mdx-source')?.textContent?.startsWith('<Map'),
    );
    expect(map?.querySelector('.mdx-live')).toBeNull();
    expect(map?.dataset.kind).toBe('jsx');
    expect(map?.querySelector('.mdx-view .mdx-name')?.textContent).toBe('Map');
    expect(liveText(a)).toBe('ferry aaaa');
  });
});
