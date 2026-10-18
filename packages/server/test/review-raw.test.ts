/**
 * A video in an attached folder opens as a member, and its bytes are served
 * with range requests — 206 for a range, 416 for one past the end — over the
 * real routes. The share-scope half sits at the bottom.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ShareTarget, shareScopeAllows } from '../src/middleware/host-guard.ts';
import { parseByteRange } from '../src/routes/review-raw.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { tinyMp4 } from './tiny-mp4.ts';
import { tinyPng } from './tiny-png.ts';
import { seedBoard } from './workspace-seed.ts';

describe('GET …/attachments/<setId>/raw', () => {
  let handle: ServerHandle;
  let root: string;
  let base: string;
  let ws = '';
  let setId = '';
  const video = tinyMp4(5000, 7);
  const outside = tinyMp4(300, 9);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'review-raw-'));
    const folder = join(root, 'harborlight');
    mkdirSync(join(folder, 'clips'), { recursive: true });
    writeFileSync(join(folder, 'notes.md'), '# Harborlight\n');
    writeFileSync(join(folder, 'clips', 'walkthrough.mp4'), video);
    writeFileSync(join(folder, 'clips', 'take.webm'), tinyMp4(64, 3));
    writeFileSync(join(folder, 'clips', 'take.mov'), tinyMp4(64, 4));
    writeFileSync(join(folder, 'chart.png'), tinyPng(40));
    writeFileSync(join(folder, 'script.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'secret.mp4'), outside);
    symlinkSync(join(root, 'secret.mp4'), join(folder, 'leak.mp4'));
    handle = createServer({ port: 0, dataDir: join(root, 'data') });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base);
    const bind = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath: folder, hubWorkspaceId: ws }),
    });
    expect(bind.status).toBe(200);
    setId = ((await bind.json()) as { setId: string }).setId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const raw = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    fetch(
      `${base}/workspaces/${ws}/attachments/${encodeURIComponent(setId)}/raw?path=${encodeURIComponent(path)}`,
      { method, headers },
    );

  it('opens a video as a member that holds no copy of its bytes', async () => {
    const res = await fetch(
      `${base}/workspaces/${ws}/attachments/${encodeURIComponent(setId)}/context-file`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath: 'clips/walkthrough.mp4' }),
      },
    );
    expect(res.status).toBe(200);
    const { docId, meta } = (await res.json()) as {
      docId: string;
      meta: { type: string; relPath: string };
    };
    expect(meta.type).toBe('code');
    expect(meta.relPath).toBe('clips/walkthrough.mp4');
    const doc = handle.docStore.get(docId);
    expect(doc?.meta.sourceUrl).toBeUndefined();
    expect(doc?.ydoc.getText('content').length).toBe(0);
  });

  it('serves the whole file with Accept-Ranges and its content type', async () => {
    const res = await raw('clips/walkthrough.mp4');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe(String(video.length));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(video);
  });

  it('answers a range with 206 and exactly those bytes', async () => {
    const res = await raw('clips/walkthrough.mp4', { range: 'bytes=100-199' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 100-199/${video.length}`);
    expect(res.headers.get('content-length')).toBe('100');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(video.slice(100, 200));
  });

  it('answers the probe Safari sends first', async () => {
    const res = await raw('clips/walkthrough.mp4', { range: 'bytes=0-1' });
    expect(res.status).toBe(206);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(video.slice(0, 2));
  });

  it('answers an open-ended range to the last byte', async () => {
    const res = await raw('clips/walkthrough.mp4', { range: 'bytes=4900-' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 4900-4999/${video.length}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(video.slice(4900));
  });

  it('answers a range past the end with 416 and the size', async () => {
    const res = await raw('clips/walkthrough.mp4', { range: 'bytes=5000-6000' });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe(`bytes */${video.length}`);
  });

  it('names the type of each video and image it serves', async () => {
    expect((await raw('clips/take.webm')).headers.get('content-type')).toBe('video/webm');
    expect((await raw('clips/take.mov')).headers.get('content-type')).toBe('video/quicktime');
    expect((await raw('chart.png')).headers.get('content-type')).toBe('image/png');
  });

  it('refuses a source file, a climb, a symlink out, and a missing file', async () => {
    expect((await raw('script.ts')).status).toBe(415);
    expect((await raw('../secret.mp4')).status).toBe(400);
    // A symlink is not listed in a folder outside git, so it is not found.
    const leak = await raw('leak.mp4');
    expect(leak.status).toBe(404);
    expect(new Uint8Array(await leak.arrayBuffer())).not.toEqual(outside);
    expect((await raw('clips/missing.mp4')).status).toBe(404);
    expect((await raw('clips/walkthrough.mp4', {}, 'POST')).status).toBe(405);
  });
});

describe('parseByteRange', () => {
  it('reads the three forms and clamps an end past the file', () => {
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ kind: 'partial', start: 0, end: 9 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseByteRange('bytes=-500', 100)).toEqual({ kind: 'partial', start: 0, end: 99 });
    expect(parseByteRange('bytes=50-500', 100)).toEqual({ kind: 'partial', start: 50, end: 99 });
  });

  it('serves whole what it will not honour, and refuses what cannot be met', () => {
    expect(parseByteRange(null, 100)).toEqual({ kind: 'full' });
    expect(parseByteRange('items=0-9', 100)).toEqual({ kind: 'full' });
    expect(parseByteRange('bytes=0-9,20-29', 100)).toEqual({ kind: 'full' });
    for (const bad of ['bytes=100-', 'bytes=9-3', 'bytes=-0', 'bytes=-', 'bytes=abc']) {
      expect(parseByteRange(bad, 100), bad).toEqual({ kind: 'unsatisfiable' });
    }
  });
});

describe('share scope for a set’s raw media', () => {
  const BOARD: ShareTarget = { workspaceId: 'ws-1' };
  const owners = (id: string) => (id === 'set-1' ? ['ws-1'] : []);

  it('admits a read wherever the share admits the set’s context-file', () => {
    const p = '/workspaces/ws-1/attachments/set-1/raw';
    expect(shareScopeAllows(p, 'GET', BOARD, owners)).toBe(true);
    expect(shareScopeAllows(p, 'HEAD', BOARD, owners)).toBe(true);
    // Control: the open verb is admitted by the same rule.
    expect(
      shareScopeAllows('/workspaces/ws-1/attachments/set-1/context-file', 'POST', BOARD, owners),
    ).toBe(true);
  });

  it('refuses a write, a set off the board, and a different board', () => {
    expect(shareScopeAllows('/workspaces/ws-1/attachments/set-1/raw', 'POST', BOARD, owners)).toBe(
      false,
    );
    expect(shareScopeAllows('/workspaces/ws-1/attachments/set-2/raw', 'GET', BOARD, owners)).toBe(
      false,
    );
    expect(shareScopeAllows('/workspaces/ws-2/attachments/set-1/raw', 'GET', BOARD, owners)).toBe(
      false,
    );
  });
});
