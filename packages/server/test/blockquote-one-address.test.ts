/**
 * A block quote written through the block-edit route is ONE address, over a
 * real server and a real bound file.
 *
 * The loss this exists to stop: `insert_blocks_under_heading` with `> some
 * quote` used to leave TWO outline entries carrying the same words — the
 * blockquote and the paragraph inside it — with nothing saying one held the
 * other. An agent deleted "the duplicate" by the paragraph's id, and the
 * quote's words went from the live doc and from the `.md`, leaving a bare `>`
 * under a lead-in sentence that ended in a colon. The route reported
 * `applied`.
 *
 * The unit cases are `packages/core/test/blockquote-outline.test.ts`. What is
 * here rather than there is the whole path an agent actually drives: the
 * markdown goes in over HTTP, the addresses come back over HTTP, and the file
 * on disk is what the assertions read.
 *
 * Fixtures are synthetic — invented names, invented meeting. The repo is
 * public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = { id: 'agent:quote-taker', name: 'Quote Taker', color: '#4a90d9' };
const QUOTE = 'We are not shipping until the migration is reversible.';
const LEAD_IN = 'Riverbend put it plainly:';

const BODY = ['# Weekly sync', '', '## Decisions', '', LEAD_IN, ''].join('\n');

interface OutlineEntry {
  id: string;
  kind: string;
  nodeName: string;
  text: string;
}

let handle: ServerHandle;
let dataDir: string;
let base: string;
let WS = '';
let seq = 0;

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function makeDoc(): Promise<{ docId: string; file: string }> {
  const docId = `quote-${seq++}`;
  const file = join(dataDir, `${docId}.md`);
  writeFileSync(file, BODY);
  const res = await post(`/workspaces/${WS}/docs`, { docId, type: 'markdown', sourceUrl: file });
  expect(res.status).toBe(200);
  return { docId, file };
}

async function outline(docId: string): Promise<OutlineEntry[]> {
  const res = await fetch(`${base}/workspaces/${WS}/docs/${docId}/outline`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { blocks: OutlineEntry[] }).blocks;
}

const blockEdits = (docId: string, edits: unknown) =>
  post(`/workspaces/${WS}/docs/${docId}/block_edits`, { author: AGENT, edits });

/** Write the quote the way `insert_blocks_under_heading` does. */
async function insertQuote(docId: string): Promise<void> {
  const headingId = (await outline(docId)).find((b) => b.text === 'Decisions')?.id;
  expect(headingId, 'no Decisions heading').toBeDefined();
  const res = await blockEdits(docId, [
    { op: 'insert_under_heading', headingId, markdown: `> ${QUOTE}\n` },
  ]);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, applied: 1, failed: 0 });
}

/** The file, once the write-back has carried `marker` into it. */
function fileCarrying(file: string, marker: string): Promise<string> {
  return waitFor(
    () => {
      const text = readFileSync(file, 'utf8');
      return text.includes(marker) ? text : null;
    },
    { describe: `the file to carry "${marker}"` },
  );
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'blockquote-address-'));
  handle = createServer({ port: 0, dataDir });
  base = `http://127.0.0.1:${handle.port}`;
  WS = await seedBoard(base);
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a block quote inserted through the block-edit route', () => {
  it('reads back as one outline entry, not a quote and a twin paragraph', async () => {
    const { docId, file } = await makeDoc();
    await insertQuote(docId);

    const blocks = await outline(docId);
    expect(blocks.filter((b) => b.text === QUOTE)).toHaveLength(1);
    expect(blocks.find((b) => b.text === QUOTE)?.nodeName).toBe('blockquote');
    // Nothing else in the doc carries the quote's words either, under any
    // spelling — the failure was two addresses for one set of words.
    expect(blocks.filter((b) => b.text.includes('reversible'))).toHaveLength(1);
    expect(await fileCarrying(file, QUOTE)).toContain(`> ${QUOTE}`);
  });

  it('survives every other address in the outline being deleted', async () => {
    // The agent's actual move, on the actual wire: delete what looks like the
    // duplicate. There is no id here that can empty the quote but the quote's.
    const { docId, file } = await makeDoc();
    await insertQuote(docId);

    for (const entry of await outline(docId)) {
      if (entry.nodeName === 'blockquote') continue;
      const res = await blockEdits(docId, [{ op: 'delete_block', blockId: entry.id }]);
      expect(res.status).toBe(200);
    }
    expect((await outline(docId)).filter((b) => b.text === QUOTE)).toHaveLength(1);
    expect(await fileCarrying(file, QUOTE)).toContain(`> ${QUOTE}`);
  });

  it('goes when its own id is the one named', async () => {
    // The positive control for the case above: the quote is deletable, so the
    // survival there is the address rule and not an inert delete path.
    const { docId, file } = await makeDoc();
    await insertQuote(docId);
    expect(await fileCarrying(file, QUOTE)).toContain(`> ${QUOTE}`);

    const quoteId = (await outline(docId)).find((b) => b.nodeName === 'blockquote')?.id;
    expect(quoteId, 'no blockquote in the outline').toBeDefined();
    const res = await blockEdits(docId, [{ op: 'delete_block', blockId: quoteId }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: 1 });

    expect((await outline(docId)).filter((b) => b.text === QUOTE)).toHaveLength(0);
    const written = await waitFor(
      () => {
        const text = readFileSync(file, 'utf8');
        return text.includes(QUOTE) ? null : text;
      },
      { describe: 'the file to lose the quote' },
    );
    expect(written).toContain(LEAD_IN);
  });
});
