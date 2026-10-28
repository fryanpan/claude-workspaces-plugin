import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import { imageVersionOf, imageVersionsMap } from '@claude-workspaces/core/image-versions';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { DocImageVersions } from '../src/doc-image-versions.ts';
import type { LiveDoc } from '../src/doc-store.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { tinyPng } from './tiny-png.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

/**
 * An image overwritten beside a bound doc is asked for at a new address, so
 * no cache keyed on the address can answer with the old bytes, and a page
 * that already has the doc open sees the new version without a reload.
 */
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

describe('an overwritten image beside a bound doc', () => {
  let handle: ServerHandle;
  let root = '';
  let base = '';
  let WS = '';
  let docDir = '';
  const first = tinyPng(40);
  const second = tinyPng(200, 3, 3);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'doc-image-versions-'));
    docDir = join(root, 'harborlight');
    mkdirSync(join(docDir, 'img'), { recursive: true });
    writeFileSync(join(docDir, 'doc.md'), '# Harborlight\n\n![chart](img/chart.png)\n');
    writeFileSync(join(docDir, 'img', 'chart.png'), first);
    handle = createServer({ port: 0, dataDir: join(root, 'data') });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
    const created = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docId: 'harborlight',
        type: 'markdown',
        sourceUrl: join(docDir, 'doc.md'),
      }),
    });
    expect(created.ok).toBe(true);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const asset = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/workspaces/${WS}/docs/harborlight/assets/${path}`, { headers });

  it('gets a new version on an open page, and the new address serves the new bytes', async () => {
    const page = openPage(`ws://127.0.0.1:${handle.port}/workspaces/${WS}/docs/harborlight/y`);
    try {
      const versions = imageVersionsMap(page.ydoc);
      const v1 = await waitFor(() => imageVersionOf(versions, 'img/chart.png'), {
        describe: 'the first version reaching the page',
      });
      expect(v1).toBe(
        Number(statSync(join(docDir, 'img', 'chart.png'), { bigint: true }).mtimeNs) / 1e6,
      );
      const before = await asset(`img/chart.png?v=${v1}`);
      expect(new Uint8Array(await before.arrayBuffer())).toEqual(first);
      const etag1 = before.headers.get('etag');
      expect(etag1).toBeTruthy();

      // The agent's overwrite. The mtime is set forward so the change does
      // not depend on the clock ticking between two writes.
      writeFileSync(join(docDir, 'img', 'chart.png'), second);
      const later = new Date(Date.now() + 60_000);
      utimesSync(join(docDir, 'img', 'chart.png'), later, later);

      const v2 = await waitFor(
        () => {
          const v = imageVersionOf(versions, 'img/chart.png');
          return v !== undefined && v !== v1 ? v : undefined;
        },
        { describe: 'the new version reaching the open page' },
      );
      expect(`img/chart.png?v=${v2}`).not.toBe(`img/chart.png?v=${v1}`);
      const after = await asset(`img/chart.png?v=${v2}`);
      expect(new Uint8Array(await after.arrayBuffer())).toEqual(second);
      expect(after.headers.get('etag')).not.toBe(etag1);
      expect(after.headers.get('last-modified')).toBe(later.toUTCString());
    } finally {
      page.close();
    }
  });

  it('answers 304 to the current validator and the bytes to an old one', async () => {
    const res = await asset('img/chart.png');
    const etag = res.headers.get('etag') ?? '';
    await res.arrayBuffer();
    expect((await asset('img/chart.png', { 'if-none-match': etag })).status).toBe(304);
    const stale = await asset('img/chart.png', { 'if-none-match': 'W/"0-0"' });
    expect(stale.status).toBe(200);
    expect(new Uint8Array(await stale.arrayBuffer())).toEqual(second);
  });

  it('leaves the .md naming the path as written', async () => {
    const doc = handle.docStore.get('harborlight');
    if (!doc) throw new Error('no doc');
    const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
    expect(md).toContain('![chart](img/chart.png)');
    expect(md).not.toContain('?v=');
  });
});

describe('DocImageVersions.refresh', () => {
  let root = '';
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'doc-image-versions-unit-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function docNaming(md: string): LiveDoc {
    const ydoc = new Y.Doc();
    prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md));
    return { docId: 'riverbend', ydoc } as unknown as LiveDoc;
  }

  it('versions only what the assets route would serve', async () => {
    const dir = join(root, 'riverbend');
    mkdirSync(dir);
    writeFileSync(join(root, 'outside.png'), tinyPng(10));
    writeFileSync(join(dir, 'here.png'), tinyPng(20));
    writeFileSync(join(dir, 'notes.txt'), 'text');
    symlinkSync(join(root, 'outside.png'), join(dir, 'leak.png'));
    const doc = docNaming(
      '![a](here.png)\n\n![b](leak.png)\n\n![c](notes.txt)\n\n![d](missing.png)\n\n![e](https://example.com/x.png)\n',
    );
    const versions = new DocImageVersions({
      openDocs: () => [doc],
      boundPathOf: () => join(dir, 'doc.md'),
    });
    await versions.refresh(doc);
    expect([...imageVersionsMap(doc.ydoc).keys()]).toEqual(['here.png']);
  });

  it('drops the version of an image the doc no longer names', async () => {
    const dir = join(root, 'saltmarsh');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.png'), tinyPng(20));
    const doc = docNaming('![a](a.png)\n');
    const versions = new DocImageVersions({
      openDocs: () => [doc],
      boundPathOf: () => join(dir, 'doc.md'),
    });
    await versions.refresh(doc);
    expect(imageVersionsMap(doc.ydoc).has('a.png')).toBe(true);
    const fragment = prose.getProseFragment(doc.ydoc);
    fragment.delete(0, fragment.length);
    fragment.push(prose.parseMarkdownBlocks('No image now.\n'));
    await versions.refresh(doc);
    expect(imageVersionsMap(doc.ydoc).size).toBe(0);
  });
});
