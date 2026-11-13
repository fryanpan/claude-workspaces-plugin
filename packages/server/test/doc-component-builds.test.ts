/**
 * A component tag in a bound `.mdx` reaches every page that has the doc open:
 * the server files its build in the synced `componentBuilds` map, the
 * components route serves the bundle that map names, and a saved component
 * file rebuilds and reaches the open page with no reload and no commit. The
 * save-to-page time is printed so the report can quote it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  componentBuildOf,
  componentBuildsMap,
  componentInputs,
} from '@claude-workspaces/core/mdx-components';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ShareTarget, shareScopeAllows } from '../src/middleware/host-guard.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const MSG_SYNC = 0;

/** A page holding the doc open: it syncs, and only listens. */
function openPage(url: string) {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    if (decoding.readVarUint(dec) !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
  });
  return { ydoc, close: () => ws.close() };
}

const GREET = (word: string) =>
  `export default function mount(el: HTMLElement) { el.textContent = ${JSON.stringify(word)}; }\n`;
const TAG = "import Greet from './components/greet.tsx'\n\n<Greet />";
const KEY =
  componentInputs(["import Greet from './components/greet.tsx'", '<Greet />'])[0]?.key ?? '';

let handle: ServerHandle;
let root = '';
let repo = '';
let base = '';
let WS = '';
let bumps = 0;

/** Overwrite a file and move its mtime forward, so the change never waits
 *  on the clock ticking between two writes. */
function save(rel: string, text: string) {
  const p = join(repo, rel);
  writeFileSync(p, text);
  const t = new Date(Date.now() + 60_000 * ++bumps);
  utimesSync(p, t, t);
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'doc-component-builds-')));
  repo = join(root, 'harborlight');
  mkdirSync(join(repo, 'components'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'components', 'component.json'), '{}');
  writeFileSync(join(repo, 'components', 'greet.tsx'), GREET('Harborlight ferry'));
  writeFileSync(join(repo, 'post.mdx'), `# Riverbend\n\n${TAG}\n`);
  handle = createServer({
    port: 0,
    dataDir: join(root, 'data'),
    componentFetch: async () => new Response('offline', { status: 503 }),
  });
  base = `http://127.0.0.1:${handle.port}`;
  WS = await seedBoard(base);
  const created = await fetch(`${base}/workspaces/${WS}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: 'post', type: 'markdown', sourceUrl: join(repo, 'post.mdx') }),
  });
  expect(created.ok).toBe(true);
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
});

const bundle = (hash: string) => fetch(`${base}/workspaces/${WS}/docs/post/components/${hash}.js`);

describe('a component tag on an open page', () => {
  it('is built, filed in the synced map, and served by the components route', async () => {
    const page = openPage(`ws://127.0.0.1:${handle.port}/workspaces/${WS}/docs/post/y`);
    try {
      const builds = componentBuildsMap(page.ydoc);
      const hash = await waitFor(() => componentBuildOf(builds, KEY)?.hash, {
        describe: 'the first build reaching the page',
      });
      const res = await bundle(hash);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('javascript');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await res.text()).toContain('Harborlight ferry');
    } finally {
      page.close();
    }
  });

  it('rebuilds a saved component file and reaches the open page, timed', async () => {
    const page = openPage(`ws://127.0.0.1:${handle.port}/workspaces/${WS}/docs/post/y`);
    try {
      const builds = componentBuildsMap(page.ydoc);
      const first = await waitFor(() => componentBuildOf(builds, KEY)?.hash, {
        describe: 'the build on the page',
      });
      const savedAt = performance.now();
      save('components/greet.tsx', GREET('Saltmarsh ferry'));
      const next = await waitFor(
        () => {
          const h = componentBuildOf(builds, KEY)?.hash;
          return h && h !== first ? h : undefined;
        },
        { describe: 'the rebuilt hash reaching the open page' },
      );
      const ms = Math.round(performance.now() - savedAt);
      console.log(`[component save-to-page] ${ms} ms from the file save to the open page's map`);
      expect(await (await bundle(next)).text()).toContain('Saltmarsh ferry');
      // The old build is no longer this doc's, so it is no longer served.
      expect((await bundle(first)).status).toBe(404);
    } finally {
      page.close();
    }
  });

  it('keeps the last good build beside the error when a save does not build', async () => {
    const page = openPage(`ws://127.0.0.1:${handle.port}/workspaces/${WS}/docs/post/y`);
    try {
      const builds = componentBuildsMap(page.ydoc);
      const good = await waitFor(() => componentBuildOf(builds, KEY)?.hash, {
        describe: 'a good build on the page',
      });
      save('components/greet.tsx', "import L from 'leaflet';\nexport default () => L;\n");
      const broken = await waitFor(() => componentBuildOf(builds, KEY)?.error, {
        describe: 'the refusal reaching the page',
      });
      expect(broken).toContain('https://esm.sh/leaflet@<exact version>');
      expect(componentBuildOf(builds, KEY)?.hash).toBe(good);
      save('components/greet.tsx', GREET('Riverbend ferry'));
      await waitFor(() => componentBuildOf(builds, KEY)?.error === undefined || undefined, {
        describe: 'the fixed build clearing the error',
      });
    } finally {
      page.close();
    }
  });

  it('refuses a bundle hash this doc does not name', async () => {
    expect((await bundle('0'.repeat(32))).status).toBe(404);
    expect((await fetch(`${base}/workspaces/${WS}/docs/post/components/..%2Fx.js`)).status).toBe(
      404,
    );
  });
});

describe('share scope for a doc’s components', () => {
  const BOARD: ShareTarget = { workspaceId: 'ws-1' };
  const owners = (id: string) => (id === 'harborlight' ? ['ws-1'] : []);
  const at = (doc: string, ws = 'ws-1') =>
    `/workspaces/${ws}/docs/${doc}/components/${'a'.repeat(32)}.js`;

  it('admits a read on a doc the share admits, and nothing else', () => {
    expect(shareScopeAllows(at('harborlight'), 'GET', BOARD, owners)).toBe(true);
    expect(shareScopeAllows(at('harborlight'), 'HEAD', BOARD, owners)).toBe(true);
    expect(shareScopeAllows(at('harborlight'), 'POST', BOARD, owners)).toBe(false);
    expect(shareScopeAllows(at('riverbend'), 'GET', BOARD, owners)).toBe(false);
    expect(shareScopeAllows(at('harborlight', 'ws-2'), 'GET', BOARD, owners)).toBe(false);
  });
});
