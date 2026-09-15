/**
 * A blank line in a doc, removed or rewritten over the wire by the id
 * `GET /workspaces/<ws>/docs/<id>/outline` handed out, through
 * `POST /workspaces/<ws>/docs/<id>/block_edits` on a real server.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = { id: 'agent:tidy', name: 'Tidy', color: '#4a90d9' };

let handle: ServerHandle;
let dataDir: string;
let base: string;
let WS = '';
let seq = 0;

interface OutlineEntry {
  id: string;
  text: string;
}

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function makeDoc(body: string): Promise<string> {
  const docId = `blank-${seq++}`;
  const file = join(dataDir, `${docId}.md`);
  writeFileSync(file, body);
  const res = await post(`/workspaces/${WS}/docs`, { docId, type: 'markdown', sourceUrl: file });
  expect(res.status).toBe(200);
  return docId;
}

async function outline(docId: string): Promise<OutlineEntry[]> {
  const res = await fetch(`${base}/workspaces/${WS}/docs/${docId}/outline`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { blocks: OutlineEntry[] }).blocks;
}

const blockEdits = (docId: string, body: unknown) =>
  post(`/workspaces/${WS}/docs/${docId}/block_edits`, body);

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'doc-block-edits-blank-'));
  handle = createServer({ port: 0, dataDir });
  base = `http://127.0.0.1:${handle.port}`;
  WS = await seedBoard(base);
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a blank line a person left', () => {
  /**
   * The id an agent reads off the outline for a blank line is the id it can
   * remove it by. On 2026-09-14 both edits naming such a line answered
   * `no-range`; the shapes are a bare paragraph and one holding only line
   * breaks, which a browser leaves after Shift+Enter on an empty line.
   */
  const blanks: Record<string, () => Y.XmlElement> = {
    'an empty paragraph': () => new Y.XmlElement('paragraph'),
    'a paragraph of line breaks': () => {
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlElement('hardBreak'), new Y.XmlElement('hardBreak')]);
      return para;
    },
  };

  async function withBlank(make: () => Y.XmlElement): Promise<{ docId: string; blankId: string }> {
    const docId = await makeDoc('## Meeting notes\n\n- Slipway opens in May\n');
    const ydoc = (handle.docStore.get(docId) as { ydoc: Y.Doc }).ydoc;
    ydoc.transact(() => prose.getProseFragment(ydoc).insert(1, [make()]), { conn: 'browser' });
    const blank = (await outline(docId)).find((b) => b.text.trim() === '');
    expect(blank, 'no blank block in the outline').toBeDefined();
    return { docId, blankId: (blank as OutlineEntry).id };
  }

  for (const [shape, make] of Object.entries(blanks)) {
    it(`${shape} is deleted by its outline id`, async () => {
      const { docId, blankId } = await withBlank(make);
      const res = await blockEdits(docId, {
        author: AGENT,
        edits: [{ op: 'delete_block', blockId: blankId }],
      });
      expect(await res.json()).toMatchObject({ applied: 1, failed: 0 });
      expect((await outline(docId)).map((b) => b.text)).toEqual([
        'Meeting notes',
        'Slipway opens in May',
      ]);
    });

    it(`${shape} is replaced by its outline id`, async () => {
      const { docId, blankId } = await withBlank(make);
      const res = await blockEdits(docId, {
        author: AGENT,
        edits: [{ op: 'replace_block', blockId: blankId, markdown: 'Agenda first' }],
      });
      expect(await res.json()).toMatchObject({ applied: 1, failed: 0 });
      expect((await outline(docId)).map((b) => b.text)).toEqual([
        'Meeting notes',
        'Agenda first',
        'Slipway opens in May',
      ]);
    });
  }
});
