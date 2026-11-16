/**
 * The prebuilt page client, as an app with no bundler loads it: the classic
 * script run as a script (so its one global is `cwCollab`), and the ES module
 * imported. Both sync a doc through the kit's Durable Object in workerd.
 * The real-browser `<script>` tag is `cw-collab-browser.test.ts`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script, createContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BuiltClient, buildClient } from '../scripts/build-client.ts';
import { until } from './poll.ts';
import { type LocalWorker, startWorker } from './workerd-harness.ts';

type Client = typeof import('../src/client/index.ts');
interface Sync {
  doc: { getText(n: string): { insert(i: number, s: string): void; toString(): string } };
  synced: Promise<void>;
  close(): void;
}

let worker: LocalWorker;
let built: BuiltClient;
let outDir: string;
const syncs: Sync[] = [];

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'cw-collab-'));
  built = buildClient(outDir);
  worker = await startWorker('doc-worker.ts', { DOC: 'DocRoom' });
}, 60_000);

afterAll(async () => {
  for (const s of syncs) s.close();
  await worker?.dispose();
  rmSync(outDir, { recursive: true, force: true });
});

/** A fresh global scope with only what a browser page would offer the
 *  script, and the classic script run in it. */
function runAsScript(): Record<string, unknown> {
  const page: Record<string, unknown> = {
    WebSocket,
    setTimeout,
    clearTimeout,
    crypto,
    console,
  };
  page.window = page;
  const context = createContext(page);
  new Script(readFileSync(built.iife, 'utf8'), { filename: 'cw-collab.js' }).runInContext(context);
  return page;
}

const url = (doc: string, user: string) => `${worker.ws}/docs/${doc}/ws?user=${user}&role=edit`;

describe('cw-collab, prebuilt', { timeout: 20_000 }, () => {
  it('as a classic script defines cwCollab and only Yjs’s own load marker', () => {
    const page = runAsScript();
    const added = Object.keys(page).filter(
      (k) =>
        !['WebSocket', 'setTimeout', 'clearTimeout', 'crypto', 'console', 'window'].includes(k),
    );
    // Yjs marks the global so a second copy on the page warns; a page that
    // also bundles Yjs itself sees that warning, which is the point of it.
    expect(added.sort()).toEqual(['__ $YJS$ __', 'cwCollab']);
    const api = page.cwCollab as Record<string, unknown>;
    for (const name of ['connectDoc', 'bindTextarea', 'watchMap', 'splice', 'Y']) {
      expect(api[name], name).toBeDefined();
    }
  });

  it('as a classic script syncs a doc between two connections', async () => {
    const one = runAsScript().cwCollab as Client;
    const two = runAsScript().cwCollab as Client;
    const a = one.connectDoc(url('harborlight-script', 'alice')) as unknown as Sync;
    const b = two.connectDoc(url('harborlight-script', 'bob')) as unknown as Sync;
    syncs.push(a, b);
    await Promise.all([a.synced, b.synced]);
    a.doc.getText('body').insert(0, 'from a script tag');
    await until(
      'the second connection to see it',
      () => b.doc.getText('body').toString() === 'from a script tag',
    );
  });

  it('as an ES module syncs a doc and renders a shared map', async () => {
    const mod = (await import(pathToFileURL(built.esm).href)) as Client;
    const a = mod.connectDoc(url('riverbend-module', 'alice'));
    const b = mod.connectDoc(url('riverbend-module', 'bob'));
    syncs.push(a, b);
    await Promise.all([a.synced, b.synced]);
    const seen: Record<string, unknown>[] = [];
    mod.watchMap(b.doc.getMap('tiles'), (v) => seen.push(v));
    a.doc.getMap('tiles').set('tide', { high: '12:04' });
    await until('the map to render on the other side', () => seen.length === 2);
    expect(seen).toEqual([{}, { tide: { high: '12:04' } }]);
  });
});
