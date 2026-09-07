/**
 * `POST …/threads/:id/insert_after` proves what it did. A peer's paragraph
 * "landed" twice according to the response and never reached the doc; the
 * verb had two ways to say ok about nothing — a body with no `text` (its
 * sibling verb's field is `markdown`) inserted the empty string, and the
 * write itself was never read back. Both are closed here, over HTTP, on a
 * real bound doc. Fixtures are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const DOC = `# Harbour notes

**On current filings the queue is essentially gone.** The mean hides it^[a trailing note].

Next paragraph.
`;

describe('insert_after on a thread', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws: string;
  let docId: string;
  let threadId: string;

  const post = (verb: string, body: unknown) =>
    fetch(
      `${base}/workspaces/${ws}/docs/${docId}/threads/${encodeURIComponent(threadId)}/${verb}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  const content = async () =>
    (await fetch(`${base}/workspaces/${ws}/docs/${docId}/content`)).text();

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-insert-after-'));
    const path = join(dataDir, 'doc.md');
    writeFileSync(path, DOC);
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    ws = await seedBoard(base);
    const create = await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'notes', type: 'markdown', sourceUrl: path }),
    });
    docId = ((await create.json()) as { docId: string }).docId;
    const created = await handle.docStore.createThreadByFind(
      docId,
      { find: 'essentially gone' },
      { id: 'u1', kind: 'known', name: 'Reviewer', color: '#000' },
      'Why the change?',
    );
    if (!created.ok) throw new Error('thread create failed');
    threadId = created.thread.id;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers with the doc text around the insert, read back after the write', async () => {
    const res = await post('insert_after', { text: ' — and it stayed gone' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; landed?: string };
    expect(body.ok).toBe(true);
    expect(body.landed).toContain('essentially gone — and it stayed gone');
    expect(await content()).toContain('essentially gone — and it stayed gone');
  });

  it('refuses a body that carries markdown instead of text, and writes nothing', async () => {
    const before = await content();
    const res = await post('insert_after', { markdown: '\n\n**Why?** Two things coincide.' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('text');
    expect(body.error).toContain('insert_blocks_after');
    expect(await content()).toBe(before);
  });

  it('refuses an empty text the same way', async () => {
    const res = await post('insert_after', { text: '' });
    expect(res.status).toBe(400);
  });

  it('still takes a whole block through the sibling verb — the control', async () => {
    const res = await post('insert_blocks_after', { markdown: '**Why?** Two things coincide.' });
    expect(res.status).toBe(200);
    expect(await content()).toContain('**Why?** Two things coincide.');
  });
});
