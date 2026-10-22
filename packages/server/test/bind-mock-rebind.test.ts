import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

// A create naming an existing doc used to REPOINT it: the same docId with
// another sourceUrl moved the doc's comments and live content onto a file of
// the caller's choosing (finding H3 of the 16 Oct security review). These
// tests pin the refusal — the doc keeps serving its first file — and that a
// re-post of the same file, or of none, still reuses the doc.
/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('bind_mock rebind (POST /workspaces/<ws>/docs on an existing mockup doc)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-rebind-test-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function postDoc(body: Record<string, unknown>) {
    const res = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return (await res.json()) as { meta: { docId: string; sourceUrl?: string } };
  }

  it('a create naming an existing doc with another file is refused and changes nothing', async () => {
    const docId = 'mock-rebind-1';
    const first = join(dataDir, 'rebind-first.html');
    const second = join(dataDir, 'rebind-second.html');
    writeFileSync(first, '<!doctype html><html><body><h1>First mock body</h1></body></html>');
    writeFileSync(second, '<!doctype html><html><body><h1>Second mock body</h1></body></html>');

    const created = await postDoc({ docId, type: 'mockup', sourceUrl: first });
    expect(created.meta.sourceUrl).toBe(first);
    const mintedId = created.meta.docId;

    const refused = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, type: 'mockup', sourceUrl: second }),
    });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: string; docId: string; conflict: string };
    expect(body).toMatchObject({ error: 'doc_exists', docId: mintedId, conflict: 'source' });

    // Nor may a create change what kind of doc the name is.
    const retyped = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, type: 'markdown', sourceUrl: second }),
    });
    expect(retyped.status).toBe(409);
    expect(((await retyped.json()) as { conflict: string }).conflict).toBe('type');

    const served = await fetch(`${base}/workspaces/${WS}/mockups/${docId}?cw-frame=1`);
    expect(served.status).toBe(200);
    expect(await served.text()).toContain('First mock body');
    const meta = (await fetch(`${base}/workspaces/${WS}/docs/${mintedId}?format=json`).then((r) =>
      r.json(),
    )) as { sourceUrl?: string; meta?: { sourceUrl?: string } };
    expect(meta.meta?.sourceUrl ?? meta.sourceUrl).toBe(first);
  });

  it('re-posting the same file reuses the doc', async () => {
    const docId = 'mock-rebind-3';
    const file = join(dataDir, 'rebind-same.html');
    writeFileSync(file, '<!doctype html><html><body><h1>Same mock body</h1></body></html>');
    const created = await postDoc({ docId, type: 'mockup', sourceUrl: file });
    const again = await postDoc({ docId, type: 'mockup', sourceUrl: file });
    expect(again.meta.docId).toBe(created.meta.docId);
    expect(again.meta.sourceUrl).toBe(file);
  });

  it('re-posting without a sourceUrl leaves the existing binding alone', async () => {
    const docId = 'mock-rebind-2';
    const file = join(dataDir, 'rebind-keep.html');
    writeFileSync(file, '<!doctype html><html><body><h1>Kept mock body</h1></body></html>');

    const created = await postDoc({ docId, type: 'mockup', sourceUrl: file });
    // e.g. a later call that only re-tags the set must not unbind the doc.
    const retagged = await postDoc({ docId, type: 'mockup', setId: 'batch-2' });
    expect(retagged.meta.sourceUrl).toBe(file);
    expect(retagged.meta.docId).toBe(created.meta.docId);
    const served = await fetch(`${base}/workspaces/${WS}/mockups/${docId}?cw-frame=1`);
    expect(served.status).toBe(200);
    expect(await served.text()).toContain('Kept mock body');
  });
});
