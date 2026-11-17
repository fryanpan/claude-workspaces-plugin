/**
 * A component's state crosses the real doc socket: a write on one open page
 * reaches another already-open page (the time is printed for the report),
 * writes two pages make to different paths before seeing each other both
 * survive on both, the state outlives a server restart in the `.ydoc`, and a
 * read-only socket receives the state while its own writes go nowhere.
 *
 * Pages are raw Yjs clients on `/workspaces/<ws>/docs/<id>/y`, writing
 * through the same hook the doc page uses (`core/mdx-component-state.ts`).
 * Read-only is the server's own: with sign-in required to write, a browser
 * socket that proved nobody is stamped `readOnly` at the upgrade.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateHook, readComponentState } from '@claude-workspaces/core/mdx-component-state';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const MSG_SYNC = 0;

/**
 * A page holding the doc open. `synced()` resolves once the server has
 * answered a sync step 1 sent after everything this page wrote so far: the
 * socket is handled in order, so by then the server has applied (or
 * dropped) those writes.
 */
function openPage(url: string, origin?: string) {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url, (origin ? { headers: { origin } } : {}) as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let waiting: Array<() => void> = [];
  const step1 = () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  };
  const opened = new Promise<void>((r) => ws.addEventListener('open', () => r()));
  ws.addEventListener('message', (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    if (decoding.readVarUint(dec) !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const kind = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (kind === syncProtocol.messageYjsSyncStep2) {
      for (const r of waiting.splice(0)) r();
    }
  });
  ydoc.on('update', (update: Uint8Array, from: unknown) => {
    if (from === ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });
  const synced = async () => {
    await opened;
    const done = new Promise<void>((r) => waiting.push(r));
    step1();
    await done;
  };
  return {
    ydoc,
    synced,
    close: () => {
      waiting = [];
      ws.close();
    },
  };
}

let root = '';
let dataDir = '';
let handle: ServerHandle;
let base = '';
let WS = '';
const url = () => `ws://127.0.0.1:${handle.port}/workspaces/${WS}/docs/map/y`;
const write = (ydoc: Y.Doc) => createStateHook(ydoc, 'map', { canWrite: true });

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'component-state-live-')));
  dataDir = join(root, 'data');
  writeFileSync(join(root, 'map.mdx'), '# Harborlight\n\nThe ferry map.\n');
  handle = createServer({ port: 0, dataDir, requireSignInToWrite: true });
  base = `http://127.0.0.1:${handle.port}`;
  WS = await seedBoard(base);
  const created = await fetch(`${base}/workspaces/${WS}/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: 'map', type: 'markdown', sourceUrl: join(root, 'map.mdx') }),
  });
  expect(created.ok).toBe(true);
});

afterAll(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('component state over the doc socket', () => {
  it('reaches an already-open page, timed', async () => {
    const alice = openPage(url());
    const bob = openPage(url());
    try {
      await Promise.all([alice.synced(), bob.synced()]);
      const seen: unknown[] = [];
      createStateHook(bob.ydoc, 'map', { canWrite: true }).on((s) => seen.push(s));
      const at = performance.now();
      expect(write(alice.ydoc).set('pins.harborlight', { lat: 37.8, lng: -122.4 })).toEqual({
        ok: true,
      });
      await waitFor(() => (seen.length > 0 ? true : undefined), {
        describe: "Alice's write reaching Bob's open page",
      });
      console.log(
        `[component state] ${Math.round(performance.now() - at)} ms from a write on one page to the other open page`,
      );
      expect(readComponentState(bob.ydoc, 'map')).toEqual({
        pins: { harborlight: { lat: 37.8, lng: -122.4 } },
      });
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('keeps writes two pages make to different paths before seeing each other', async () => {
    const alice = openPage(url());
    const bob = openPage(url());
    try {
      await Promise.all([alice.synced(), bob.synced()]);
      write(alice.ydoc).set('pins.saltmarsh', { x: 1 });
      await alice.synced();
      await waitFor(
        () => (readComponentState(bob.ydoc, 'map').pins as object | undefined) && true,
        {
          describe: 'the pins reaching Bob',
        },
      );
      // Applied to each page's own doc in one tick, so neither has seen the
      // other's write when it makes its own.
      write(alice.ydoc).set('pins.saltmarsh.x', 5);
      write(bob.ydoc).set('pins.harborlight.label', 'Riverbend');
      await Promise.all([alice.synced(), bob.synced()]);
      const want = {
        pins: {
          harborlight: { label: 'Riverbend', lat: 37.8, lng: -122.4 },
          saltmarsh: { x: 5 },
        },
      };
      for (const page of [alice, bob]) {
        await waitFor(
          () => Bun.deepEquals(readComponentState(page.ydoc, 'map'), want) || undefined,
          { describe: 'both writes on both pages' },
        );
      }
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('shows a read-only socket the state, and drops what it writes', async () => {
    const reader = openPage(url(), base);
    const alice = openPage(url());
    try {
      await Promise.all([reader.synced(), alice.synced()]);
      write(alice.ydoc).set('filter', 'open');
      await waitFor(() => readComponentState(reader.ydoc, 'map').filter === 'open' || undefined, {
        describe: 'the state reaching the read-only page',
      });
      // A client that ignores what it was told and writes anyway. The page's
      // own hook refuses first (canWrite false); this is the server's half.
      write(reader.ydoc).set('filter', 'Bob was here');
      await reader.synced();
      // Positive control on the same path: a writer's write through the
      // same server lands, so the check below can tell a drop from a delay.
      write(alice.ydoc).set('checked', true);
      await alice.synced();
      const fresh = openPage(url());
      try {
        await fresh.synced();
        const state = readComponentState(fresh.ydoc, 'map');
        expect(state.checked).toBe(true);
        expect(state.filter).toBe('open');
      } finally {
        fresh.close();
      }
    } finally {
      reader.close();
      alice.close();
    }
  });

  it('keeps the state in the .ydoc across a server restart', async () => {
    await handle.stop();
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: true });
    base = `http://127.0.0.1:${handle.port}`;
    const page = openPage(url());
    try {
      await page.synced();
      expect(readComponentState(page.ydoc, 'map')).toMatchObject({
        filter: 'open',
        pins: { saltmarsh: { x: 5 } },
      });
    } finally {
      page.close();
    }
  });
});
