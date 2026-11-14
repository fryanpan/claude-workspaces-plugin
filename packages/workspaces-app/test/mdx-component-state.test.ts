import { prose } from '@claude-workspaces/core';
import {
  type ComponentHostApi,
  type MountFn,
  type StateHook,
  jsx,
  render,
} from '@claude-workspaces/core/mdx-component-runtime';
import { componentBuildsMap, componentInputs } from '@claude-workspaces/core/mdx-components';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createEditor } from '../src/editor.ts';
import { setComponentDoc, setComponentLoaderForTest } from '../src/mdx-component.ts';

/**
 * A component's state is live across pages: a write made in a component on
 * one open page redraws the same component on another open page, with no
 * reload; a page that may only read sees the state, and its write is refused
 * with the reason shown under the component.
 *
 * Each page is the real editor over its own Y.Doc. The pages reach each
 * other only through a third Y.Doc standing in for the server, which relays
 * every update the way the doc socket does — and drops a read-only page's,
 * as `yjs-protocol.ts` does. The bundle is the runtime's own `render` over a
 * component that draws the state's `filter` and keeps the hook it was given.
 */

const IMPORT = "import Map from './map/index.ts'";
const TAG = '<Map id="map" />';
const DOC = `# Riverbend\n\n${IMPORT}\n\n${TAG}\n`;
const KEY = componentInputs([IMPORT, TAG])[0]?.key ?? '';
const HASH = 'a'.repeat(32);

const open: Array<() => void> = [];
/** The hook each page's component was handed, by page. */
let hooks: Map<HTMLElement, StateHook>;
/** The page whose bundle is mounting: the component's own element is not
 *  in the document yet while it mounts. */
let mounting: HTMLElement | null = null;

const MapComponent: MountFn = (el, _props, state) => {
  const draw = () => {
    el.textContent = `filter: ${String(state?.get('filter') ?? 'none')}`;
  };
  draw();
  if (!state) return;
  if (mounting) hooks.set(mounting, state);
  return state.on(draw);
};

beforeEach(() => {
  history.replaceState(null, '', '/workspaces/w-harbor/docs/d-map');
  hooks = new Map();
  setComponentLoaderForTest(async () => ({
    default: (host: HTMLElement, api: ComponentHostApi) => {
      mounting = host.closest<HTMLElement>('.page');
      return render(host, api, () => jsx(MapComponent, { id: 'map' }));
    },
  }));
});

afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
  setComponentLoaderForTest(null);
});

function serverDoc(): Y.Doc {
  const server = new Y.Doc();
  prose.getProseFragment(server).push(prose.parseMarkdownBlocks(DOC, { mdx: true }));
  componentBuildsMap(server).set(KEY, { hash: HASH, at: Date.now() });
  return server;
}

/** Open the doc on a page wired to `server`. */
function openPage(server: Y.Doc, canWrite = true): HTMLElement {
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
  page.className = 'page';
  document.body.appendChild(page);
  const handle = createEditor({ parent: page, ydoc: client, awareness: new Awareness(client) });
  open.push(() => {
    handle.destroy();
    server.off('update', down);
  });
  return page;
}

const drawn = (page: HTMLElement) => page.querySelector('.mdx-live')?.textContent ?? '';
const status = (page: HTMLElement) => page.querySelector<HTMLElement>('.mdx-live-status');
const settle = async (until: () => boolean) => {
  for (let i = 0; i < 100 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('component state across open pages', () => {
  it('redraws the component on the other open page when one page writes', async () => {
    const server = serverDoc();
    const alice = openPage(server);
    const bob = openPage(server);
    await settle(() => hooks.size === 2);
    expect(drawn(bob)).toBe('filter: none');

    expect(hooks.get(alice)?.set('filter', 'open')).toEqual({ ok: true });
    await settle(() => drawn(bob) === 'filter: open');
    expect(drawn(bob)).toBe('filter: open');
    expect(drawn(alice)).toBe('filter: open');

    expect(hooks.get(bob)?.set('filter', 'Saltmarsh')).toEqual({ ok: true });
    await settle(() => drawn(alice) === 'filter: Saltmarsh');
    expect(drawn(alice)).toBe('filter: Saltmarsh');
  });

  it('shows a read-only page the state and refuses its write, saying why', async () => {
    const server = serverDoc();
    const alice = openPage(server);
    const reader = openPage(server, false);
    await settle(() => hooks.size === 2);
    hooks.get(alice)?.set('filter', 'open');
    await settle(() => drawn(reader) === 'filter: open');
    expect(drawn(reader)).toBe('filter: open');

    const hook = hooks.get(reader);
    expect(hook?.canWrite).toBe(false);
    const out = hook?.set('filter', 'closed');
    expect(out?.ok).toBe(false);
    expect(status(reader)?.hidden).toBe(false);
    expect(status(reader)?.textContent).toMatch(/can only read/);
    expect(drawn(alice)).toBe('filter: open');
    expect(drawn(reader)).toBe('filter: open');
  });

  it('shows a refused write past a limit under the component, and clears it on the next write', async () => {
    const server = serverDoc();
    const alice = openPage(server);
    await settle(() => hooks.size === 1);
    const hook = hooks.get(alice);
    const out = hook?.set('blob', 'x'.repeat(300 * 1024));
    expect(out?.ok).toBe(false);
    expect(status(alice)?.textContent).toMatch(/256 KB/);
    expect(status(alice)?.classList.contains('is-error')).toBe(true);
    expect(hook?.set('filter', 'open')).toEqual({ ok: true });
    expect(status(alice)?.hidden).toBe(true);
  });

  it('keeps a failed build’s reason when a later write is accepted', async () => {
    const server = serverDoc();
    const alice = openPage(server);
    await settle(() => hooks.size === 1);
    const hook = hooks.get(alice);
    expect(hook?.set('blob', 'x'.repeat(300 * 1024)).ok).toBe(false);
    componentBuildsMap(server).set(KEY, { hash: HASH, error: 'a bare import', at: Date.now() });
    await settle(() => status(alice)?.textContent === 'a bare import');
    expect(hook?.set('filter', 'open')).toEqual({ ok: true });
    expect(status(alice)?.textContent).toBe('a bare import');
    expect(status(alice)?.hidden).toBe(false);
  });
});
