/**
 * An image line in a bound doc, replaced or removed by an agent through
 * `POST /workspaces/<ws>/docs/<id>/block_edits`, reaches the `.md` on disk.
 *
 * The lines come from the file, so no agent owns them, and an edit of a block
 * the agent does not own becomes a proposal: a strike-through over the
 * block's words. An image holds no words, so both edits answered `no-range`
 * and the agent had no way to change the line.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitForFileToBe } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = { id: 'agent:charts', name: 'Charts', color: '#4a90d9' };

interface OutlineEntry {
  id: string;
  nodeName: string;
  text: string;
}

let handle: ServerHandle;
let dataDir = '';
let base = '';
let WS = '';

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'doc-block-edits-image-'));
  handle = createServer({ port: 0, dataDir });
  base = `http://127.0.0.1:${handle.port}`;
  WS = await seedBoard(base);
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('an image line in a bound doc', () => {
  it('is replaced with a new src and alt, and another is removed, on disk', async () => {
    const file = join(dataDir, 'harborlight.md');
    writeFileSync(
      file,
      '# Harborlight\n\nTide heights by month.\n\n![old chart](img/tides-v1.png)\n\n![draft](img/draft.png)\n\nEnd.\n',
    );
    const made = await post(`/workspaces/${WS}/docs`, {
      docId: 'harborlight',
      type: 'markdown',
      sourceUrl: file,
    });
    expect(made.status).toBe(200);
    const res = await fetch(`${base}/workspaces/${WS}/docs/harborlight/outline`);
    const images = ((await res.json()) as { blocks: OutlineEntry[] }).blocks.filter(
      (b) => b.nodeName === 'image',
    );
    expect(images).toHaveLength(2);
    const [chart, draft] = images as [OutlineEntry, OutlineEntry];

    const edited = await post(`/workspaces/${WS}/docs/harborlight/block_edits`, {
      author: AGENT,
      edits: [
        { op: 'replace_block', blockId: chart.id, markdown: '![tide chart](img/tides-v2.png)' },
        { op: 'delete_block', blockId: draft.id },
      ],
    });
    expect(await edited.json()).toMatchObject({ applied: 2, failed: 0 });
    await waitForFileToBe(
      file,
      '# Harborlight\n\nTide heights by month.\n\n![tide chart](img/tides-v2.png)\n\nEnd.\n',
    );
  });
});
