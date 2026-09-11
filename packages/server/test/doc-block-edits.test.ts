/**
 * The two block-addressed doc routes, over a real server:
 * `GET  /workspaces/<ws>/docs/<id>/outline` and
 * `POST /workspaces/<ws>/docs/<id>/block_edits`.
 *
 * What is under test here rather than in the unit suite is everything between
 * the wire and `prose`: that a read hands back addresses an edit can be sent
 * with, that a batch lands where the id said, that every malformed body is
 * refused with the index and the field named — a batch is ONE transaction, so
 * "one of your edits is wrong" is not an answer a caller can act on — and that
 * an edit onto words a person wrote becomes a proposal instead of overwriting
 * them. The last one is the whole safety property: it is asserted on the
 * doc's own content, not on the outcome label the route reported.
 *
 * Fixtures are synthetic — invented names, invented meeting. The repo is
 * public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = { id: 'agent:note-taker', name: 'Note Taker', color: '#4a90d9' };

const BODY = [
  '# Weekly sync',
  '',
  'Jordan opened with the migration.',
  '',
  '## Decisions',
  '',
  'Ship Friday.',
  '',
].join('\n');

let handle: ServerHandle;
let dataDir: string;
let base: string;
let WS = '';
let seq = 0;

interface OutlineEntry {
  id: string;
  kind: string;
  level?: number;
  text: string;
  author?: string;
  underHeadingId?: string;
}

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** A fresh markdown doc, bound to its own file, filed on the board. */
async function makeDoc(): Promise<string> {
  const docId = `blk-${seq++}`;
  const file = join(dataDir, `${docId}.md`);
  writeFileSync(file, BODY);
  const res = await post(`/workspaces/${WS}/docs`, { docId, type: 'markdown', sourceUrl: file });
  expect(res.status).toBe(200);
  return docId;
}

async function outline(docId: string, query = ''): Promise<OutlineEntry[]> {
  const res = await fetch(`${base}/workspaces/${WS}/docs/${docId}/outline${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { blocks: OutlineEntry[] }).blocks;
}

/** The id of the block whose text is `text`. */
async function idOf(docId: string, text: string): Promise<string> {
  const entry = (await outline(docId)).find((b) => b.text === text);
  expect(entry, `no block reading "${text}"`).toBeDefined();
  return (entry as OutlineEntry).id;
}

const blockEdits = (docId: string, body: unknown) =>
  post(`/workspaces/${WS}/docs/${docId}/block_edits`, body);

/** The doc's plain text, as `get_doc` returns it. */
async function plainText(docId: string): Promise<string> {
  const res = await fetch(`${base}/workspaces/${WS}/docs/${docId}/content`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { plainText: string }).plainText;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'doc-block-edits-'));
  handle = createServer({ port: 0, dataDir });
  base = `http://127.0.0.1:${handle.port}`;
  WS = await seedBoard(base);
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GET …/outline', () => {
  it('hands back an address for every block, and the section each sits in', async () => {
    const docId = await makeDoc();
    const blocks = await outline(docId);
    expect(blocks.map((b) => b.text)).toEqual([
      'Weekly sync',
      'Jordan opened with the migration.',
      'Decisions',
      'Ship Friday.',
    ]);
    expect(blocks.every((b) => typeof b.id === 'string' && b.id.length > 0)).toBe(true);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(blocks.length);
    const decisions = blocks.find((b) => b.text === 'Decisions') as OutlineEntry;
    expect(decisions.kind).toBe('heading');
    expect(decisions.level).toBe(2);
    expect(blocks.find((b) => b.text === 'Ship Friday.')?.underHeadingId).toBe(decisions.id);

    // The ids are STABLE across reads — an address re-minted per read would
    // address nothing by the time an edit came back with it.
    expect((await outline(docId)).map((b) => b.id)).toEqual(blocks.map((b) => b.id));
  });

  it('answers headings_only and recent, and refuses a recent that is not one', async () => {
    const docId = await makeDoc();
    expect((await outline(docId, '?headings_only=1')).map((b) => b.text)).toEqual([
      'Weekly sync',
      'Decisions',
    ]);
    expect((await outline(docId, '?recent=1')).map((b) => b.text)).toEqual([
      'Weekly sync',
      'Decisions',
      'Ship Friday.',
    ]);
    for (const bad of ['abc', '-1', '1.5', '501']) {
      const res = await fetch(`${base}/workspaces/${WS}/docs/${docId}/outline?recent=${bad}`);
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { field: string }).field, bad).toBe('recent');
    }
  });

  it('404s a doc that does not exist', async () => {
    const res = await fetch(`${base}/workspaces/${WS}/docs/no-such-doc/outline`);
    expect(res.status).toBe(404);
  });
});

describe('POST …/block_edits', () => {
  it('lands a batch under the heading its id named, and claims what it wrote', async () => {
    const docId = await makeDoc();
    const headingId = await idOf(docId, 'Decisions');
    const res = await blockEdits(docId, {
      author: AGENT,
      edits: [
        { op: 'insert_under_heading', headingId, markdown: 'Freeze the schema on Wednesday.' },
        { op: 'insert_under_heading', headingId, markdown: 'Jordan owns the rollback note.' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, applied: 2, suggested: 0, failed: 0 });

    const after = await outline(docId);
    expect(after.map((b) => b.text)).toEqual([
      'Weekly sync',
      'Jordan opened with the migration.',
      'Decisions',
      'Ship Friday.',
      'Freeze the schema on Wednesday.',
      'Jordan owns the rollback note.',
    ]);
    // Marked as the batch's own, which is what later lets it rewrite them —
    // and nothing it did not write picked up a claim.
    expect(after.at(-1)?.author).toBe(AGENT.id);
    expect(after.find((b) => b.text === 'Ship Friday.')?.author).toBeUndefined();
  });

  it('proposes, rather than overwrites, a block the caller does not own', async () => {
    const docId = await makeDoc();
    const blockId = await idOf(docId, 'Jordan opened with the migration.');
    const res = await blockEdits(docId, {
      author: AGENT,
      edits: [{ op: 'replace_block', blockId, markdown: 'The agent rewrote this line.' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      applied: number;
      suggested: number;
      outcomes: Array<{ status: string; suggestionId?: string }>;
    };
    expect(body).toMatchObject({ applied: 0, suggested: 1 });
    expect(body.outcomes[0]?.status).toBe('suggested');

    // THE SAFETY PROPERTY, asserted on the doc rather than on the label: the
    // person's words are still there, and what the batch wanted to say is a
    // proposal somebody can accept rather than content it wrote.
    expect(await plainText(docId)).toContain('Jordan opened with the migration.');
    const list = await fetch(`${base}/workspaces/${WS}/docs/${docId}/suggestions`);
    const pending = ((await list.json()) as { suggestions: Array<{ sid: string }> }).suggestions;
    expect(pending.length).toBe(1);
    expect(body.outcomes[0]?.suggestionId).toBe(pending[0]?.sid as string);
  });

  it('applies its own block directly, once it owns one', async () => {
    const docId = await makeDoc();
    const headingId = await idOf(docId, 'Decisions');
    await blockEdits(docId, {
      author: AGENT,
      edits: [{ op: 'insert_under_heading', headingId, markdown: 'First draft of the note.' }],
    });
    const mine = await idOf(docId, 'First draft of the note.');
    const res = await blockEdits(docId, {
      author: AGENT,
      edits: [{ op: 'replace_block', blockId: mine, markdown: 'Second draft of the note.' }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: 1, suggested: 0, failed: 0 });
    expect((await outline(docId)).map((b) => b.text)).toContain('Second draft of the note.');
  });

  it('refuses every malformed batch by index and field, changing nothing', async () => {
    const docId = await makeDoc();
    const blockId = await idOf(docId, 'Ship Friday.');
    const before = await plainText(docId);
    const cases: Array<[string, unknown, string]> = [
      ['not an array', { edits: 'insert everything' }, 'edits must be an array'],
      ['an empty array', { edits: [] }, 'edits must not be empty'],
      [
        'more than fifty',
        { edits: Array.from({ length: 51 }, () => ({ op: 'insert_at_end', markdown: 'x' })) },
        'at most 50',
      ],
      ['a non-object entry', { edits: ['insert_at_end'] }, 'edits[0] must be an object'],
      ['an unknown op', { edits: [{ op: 'rewrite_everything', markdown: 'x' }] }, 'edits[0].op'],
      [
        'oversized markdown',
        { edits: [{ op: 'insert_at_end', markdown: 'x'.repeat(20_001) }] },
        'edits[0].markdown',
      ],
      ['missing markdown', { edits: [{ op: 'insert_at_end' }] }, 'edits[0].markdown'],
      ['a missing blockId', { edits: [{ op: 'delete_block' }] }, 'edits[0].blockId'],
      [
        'a non-string blockId',
        { edits: [{ op: 'replace_block', blockId: 7, markdown: 'x' }] },
        'edits[0].blockId',
      ],
      [
        'a missing headingId',
        { edits: [{ op: 'insert_under_heading', markdown: 'x' }] },
        'edits[0].headingId',
      ],
      [
        'the offending index, not the first',
        {
          edits: [
            { op: 'delete_block', blockId },
            { op: 'delete_block', blockId: null },
          ],
        },
        'edits[1].blockId',
      ],
    ];
    for (const [name, body, needle] of cases) {
      const res = await blockEdits(docId, { author: AGENT, ...(body as object) });
      expect(res.status, name).toBe(400);
      expect(((await res.json()) as { error: string }).error, name).toContain(needle);
    }
    // A refused batch is a batch that did nothing — including the valid first
    // edit of the last case, which is the point of one transaction.
    expect(await plainText(docId)).toBe(before);
  });

  it('refuses a batch that names no author, since every block is attributed', async () => {
    const docId = await makeDoc();
    const res = await blockEdits(docId, { edits: [{ op: 'insert_at_end', markdown: 'orphan' }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('author');
    expect(await plainText(docId)).not.toContain('orphan');
  });
});

describe('a person typing hands the block back', () => {
  /**
   * The authorship model is only worth anything if "still marked the agent's"
   * also means "no person has touched it since" — otherwise the batch's
   * direct-write path would eventually overwrite words somebody typed.
   * `prose.clearAuthorshipOnPersonEdit` does the clearing; what is asserted
   * here is that the STORE installs it on every prose doc it hydrates, which
   * is the half a core unit test cannot see.
   */
  it('clears the agent claim on the block a person edits, and only that block', async () => {
    const docId = await makeDoc();
    const headingId = await idOf(docId, 'Decisions');
    await blockEdits(docId, {
      author: AGENT,
      edits: [
        { op: 'insert_under_heading', headingId, markdown: 'Agent line one.' },
        { op: 'insert_under_heading', headingId, markdown: 'Agent line two.' },
      ],
    });
    const claimed = (await outline(docId)).filter((b) => b.author === AGENT.id);
    expect(claimed.map((b) => b.text)).toEqual(['Agent line one.', 'Agent line two.']);

    // A person types into the first of them. A browser's edit arrives on the
    // collaboration socket with the CONNECTION as its transaction origin —
    // every server-side writer names itself with a string instead — so a
    // non-string origin is precisely what makes this a person's keystroke.
    const live = handle.docStore.get(docId);
    expect(live, 'the doc is not resident').toBeDefined();
    const ydoc = (live as { ydoc: Y.Doc }).ydoc;
    const target = prose
      .addressableBlocks(prose.getProseFragment(ydoc))
      .find((el) => prose.outlineTextOf(el) === 'Agent line one.');
    expect(target, 'no block holding the agent line').toBeDefined();
    const text = (target as Y.XmlElement).toArray()[0];
    expect(text).toBeInstanceOf(Y.XmlText);
    ydoc.transact(() => (text as Y.XmlText).insert(0, 'Jordan: '), { conn: 'browser' });

    const after = await outline(docId);
    expect(after.find((b) => b.text.includes('Agent line one.'))?.author).toBeUndefined();
    // The neighbour is untouched: the unit is the block, not the doc.
    expect(after.find((b) => b.text === 'Agent line two.')?.author).toBe(AGENT.id);
  });
});
