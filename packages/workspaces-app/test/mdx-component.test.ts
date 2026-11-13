import { prose } from '@claude-workspaces/core';
import type { ComponentHostApi } from '@claude-workspaces/core/mdx-component-runtime';
import { componentBuildsMap, componentInputs } from '@claude-workspaces/core/mdx-components';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createEditor } from '../src/editor.ts';
import { setComponentDoc, setComponentLoaderForTest } from '../src/mdx-component.ts';

/**
 * A component tag in a bound `.mdx` draws the bundle the server filed for it
 * in the doc's `componentBuilds` map, live in the page; it remounts when, and
 * only when, its own build's hash moves; and a build that failed keeps the
 * component that drew, with the reason under it.
 *
 * Driven through the real editor over a fragment parsed the way the server
 * parses an `.mdx`, with the server's copy of the doc writing the map as
 * `doc-component-builds.ts` does, and the bundle import swapped for a module
 * built here.
 */

const IMPORT = "import Ferry from './components/ferry.tsx'";
const TAG = '<Ferry route="Harborlight" />';
const OTHER = '<Ferry route="Saltmarsh" />';
const DOC = `# Riverbend\n\n${IMPORT}\n\n${TAG}\n\n${OTHER}\n`;
const keyOf = (tag: string) =>
  componentInputs([IMPORT, TAG, OTHER]).find((i) => i.tag === tag)?.key ?? '';

const open: Array<() => void> = [];
let loads: string[] = [];
let mounts: string[] = [];
let cleanups: string[] = [];

/** A bundle per hash: it writes the hash into its host. */
function moduleFor(url: string) {
  const hash = /([a-f0-9]{32})\.js$/.exec(url)?.[1] ?? '?';
  return {
    default: (host: HTMLElement, _api: ComponentHostApi) => {
      mounts.push(hash);
      host.textContent = `ferry ${hash.slice(0, 4)}`;
      return () => cleanups.push(hash);
    },
  };
}

beforeEach(() => {
  history.replaceState(null, '', '/workspaces/w-harbor/docs/d-ferry');
  loads = [];
  mounts = [];
  cleanups = [];
  setComponentLoaderForTest(async (url) => {
    loads.push(url);
    return moduleFor(url);
  });
});

afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
  setComponentLoaderForTest(null);
});

function mount(md: string, isMdx = true): { server: Y.Doc } {
  const server = new Y.Doc();
  prose.getProseFragment(server).push(prose.parseMarkdownBlocks(md, { mdx: true }));
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  server.on('update', (u: Uint8Array) => Y.applyUpdate(client, u));
  setComponentDoc(client, isMdx);
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc: client, awareness: new Awareness(client) });
  open.push(() => handle.destroy());
  return { server };
}

const file = (server: Y.Doc, key: string, build: { hash?: string; error?: string }) =>
  componentBuildsMap(server).set(key, { ...build, at: Date.now() });

const HASH_A = 'a'.repeat(32);
const HASH_B = 'b'.repeat(32);
const HASH_C = 'c'.repeat(32);

const hosts = () => [...document.querySelectorAll<HTMLElement>('.ProseMirror .mdx-live')];
const statuses = () => [...document.querySelectorAll<HTMLElement>('.ProseMirror .mdx-live-status')];
const settle = async (until: () => boolean) => {
  for (let i = 0; i < 50 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('a component tag on the doc page', () => {
  it('says it is building, then draws the bundle its build names', async () => {
    const { server } = mount(DOC);
    await settle(() => hosts().length === 2);
    expect(hosts()).toHaveLength(2);
    expect(statuses()[0]?.textContent).toBe('Building…');
    file(server, keyOf(TAG), { hash: HASH_A });
    await settle(() => mounts.length === 1);
    expect(loads).toEqual([
      `${location.origin}/workspaces/w-harbor/docs/d-ferry/components/${HASH_A}.js`,
    ]);
    expect(hosts()[0]?.textContent).toBe('ferry aaaa');
    expect(statuses()[0]?.hidden).toBe(true);
  });

  it('leaves a drawn component alone when another tag’s build moves', async () => {
    const { server } = mount(DOC);
    file(server, keyOf(TAG), { hash: HASH_A });
    await settle(() => mounts.length === 1);
    file(server, keyOf(OTHER), { hash: HASH_B });
    await settle(() => mounts.length === 2);
    file(server, keyOf(OTHER), { hash: HASH_C });
    await settle(() => mounts.length === 3);
    expect(mounts).toEqual([HASH_A, HASH_B, HASH_C]);
    expect(cleanups).toEqual([HASH_B]);
    expect(hosts()[0]?.textContent).toBe('ferry aaaa');
  });

  it('remounts on a new hash, cleaning up the old one', async () => {
    const { server } = mount(DOC);
    file(server, keyOf(TAG), { hash: HASH_A });
    await settle(() => mounts.length === 1);
    file(server, keyOf(TAG), { hash: HASH_B });
    await settle(() => mounts.length === 2);
    expect(cleanups).toEqual([HASH_A]);
    expect(hosts()[0]?.textContent).toBe('ferry bbbb');
  });

  it('keeps the drawn component beside a failed build’s reason', async () => {
    const { server } = mount(DOC);
    file(server, keyOf(TAG), { hash: HASH_A });
    await settle(() => mounts.length === 1);
    file(server, keyOf(TAG), { hash: HASH_A, error: "'leaflet' is a bare import" });
    await settle(() => statuses()[0]?.hidden === false);
    expect(statuses()[0]?.textContent).toBe("'leaflet' is a bare import");
    expect(statuses()[0]?.classList.contains('is-error')).toBe(true);
    expect(hosts()[0]?.textContent).toBe('ferry aaaa');
    expect(mounts).toEqual([HASH_A]);
  });

  it('draws nothing live in a .md doc, whatever its map names', async () => {
    const { server } = mount(DOC, false);
    file(server, keyOf(TAG), { hash: HASH_A });
    await settle(() => mounts.length > 0);
    expect(hosts()).toHaveLength(0);
    expect(loads).toEqual([]);
  });

  it('keeps the preview for a tag no buildable import names', async () => {
    mount('# Riverbend\n\n<Note title="Saltmarsh" />\n');
    await settle(() => false);
    expect(hosts()).toHaveLength(0);
    expect(document.querySelector('.ProseMirror .mdx-view .mdx-title')?.textContent).toBe(
      'Saltmarsh',
    );
  });
});
