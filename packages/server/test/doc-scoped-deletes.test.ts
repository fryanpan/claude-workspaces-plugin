/**
 * The two scoped deletes an agent makes through the doc routes:
 * `delete_section` (a heading and everything under it) and
 * `delete_block_at_anchor` (the block an agent anchor sits in). Both are
 * declared in `routes/doc-edits-contract.ts`. Each case drives the route on a
 * real server and reads the doc back, so what is asserted is what a reader
 * of the doc would see afterwards.
 *
 * All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

let handle: ServerHandle;
let dataDir: string;
let base = '';
let ws = '';
let made = 0;

async function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

/** A new file-backed doc holding `markdown`; answers its path under the board. */
async function docWith(markdown: string): Promise<string> {
  made++;
  const docId = `riverbend-notes-${made}`;
  const file = join(dataDir, `${docId}.md`);
  writeFileSync(file, markdown);
  const r = await post(`/workspaces/${ws}/docs`, { docId, sourceUrl: file });
  expect(r.status).toBe(200);
  return `/workspaces/${ws}/docs/${docId}`;
}

async function plainText(doc: string): Promise<string> {
  const r = await fetch(`${base}${doc}/content`);
  return ((await r.json()) as { plainText: string }).plainText;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'doc-scoped-deletes-'));
  handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
  base = `http://127.0.0.1:${handle.port}`;
  ws = await seedBoard(base, { name: 'Saltmarsh' });
});

afterAll(() => {
  handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST …/delete_section', () => {
  it('removes the heading and its body, and keeps the sections around it', async () => {
    const doc = await docWith(
      '# Plan\n\n## Keep\n\nStays.\n\n## Drop\n\nGoes.\n\n## After\n\nAlso stays.\n',
    );
    const r = await post(`${doc}/delete_section`, { heading: 'Drop', level: 2 });
    expect(r.status).toBe(200);
    const text = await plainText(doc);
    expect(text).not.toContain('Goes.');
    expect(text).toContain('Stays.');
    expect(text).toContain('Also stays.');
  });

  it('refuses a heading the doc does not have, and changes nothing', async () => {
    const doc = await docWith('# Plan\n\n## Keep\n\nStays.\n');
    const r = await post(`${doc}/delete_section`, { heading: 'Missing' });
    expect(r.status).toBe(409);
    expect(await plainText(doc)).toContain('Stays.');
  });
});

describe('POST …/delete_block_at_anchor', () => {
  it('removes the block an agent anchor sits in', async () => {
    const doc = await docWith('# Plan\n\nFirst paragraph.\n\nSecond paragraph.\n');
    const anchor = await post(`${doc}/agent_anchors`, { find: 'Second paragraph' });
    expect(anchor.status).toBe(200);
    const anchorId = (anchor.json as { anchorId: string }).anchorId;
    const r = await post(`${doc}/delete_block_at_anchor`, { anchorId });
    expect(r.status).toBe(200);
    const text = await plainText(doc);
    expect(text).not.toContain('Second paragraph.');
    expect(text).toContain('First paragraph.');
  });

  it('refuses an anchor that does not exist, and changes nothing', async () => {
    const doc = await docWith('# Plan\n\nOnly paragraph.\n');
    const r = await post(`${doc}/delete_block_at_anchor`, { anchorId: 'no-such-anchor' });
    expect(r.status).toBe(409);
    expect(await plainText(doc)).toContain('Only paragraph.');
  });
});
