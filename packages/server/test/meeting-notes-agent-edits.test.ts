/**
 * An agent cleaning up the Meeting Assistant's notes edits them directly.
 *
 * `apply_block_edits` decides direct-vs-proposal by authorship: a replace or
 * delete applies directly only to a block still marked as the caller's own.
 * The note-taker stamps every block it writes `cwAuthor = meeting-notes`, so
 * every other agent read those blocks as somebody else's and every delete or
 * rewrite of them became a suggestion waiting on a person. The mark is
 * cleared the moment a person types in a block, so a block still carrying it
 * holds no words a person wrote — the thing proposals exist to protect.
 *
 * The block-edit route therefore lets an agent replace or delete a block
 * still marked as the note-taker's. A note a person has edited still comes
 * back as a proposal, and so does a block a person wrote.
 *
 * Fixtures are synthetic: an invented meeting about an invented harbour.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { NOTES_AUTHOR_ID, NOTES_SUGGESTION_AUTHOR } from '../src/notes-doc-access.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const AGENT = { id: 'agent:tidy', name: 'Tidy Agent', color: '#4a90d9' };

const BODY = [
  '# Harborlight planning',
  '',
  'Alice wrote this agenda by hand.',
  '',
  '## Meeting notes',
  '',
].join('\n');

const NOTES = [
  'Alice will draft the dock schedule.',
  'Bob asked about the ferry budget.',
  'The group agreed to meet Thursday.',
];

let handle: ServerHandle;
let dataDir: string;
let base: string;
let WS = '';
let seq = 0;

interface OutlineEntry {
  id: string;
  text: string;
  author?: string;
}

interface BatchResult {
  applied: number;
  suggested: number;
  failed: number;
}

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const blockEdits = (docId: string, body: unknown) =>
  post(`/workspaces/${WS}/docs/${docId}/block_edits`, body);

async function outline(docId: string): Promise<OutlineEntry[]> {
  const res = await fetch(`${base}/workspaces/${WS}/docs/${docId}/outline`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { blocks: OutlineEntry[] }).blocks;
}

async function idOf(docId: string, text: string): Promise<string> {
  const entry = (await outline(docId)).find((b) => b.text === text);
  expect(entry, `no block reading "${text}"`).toBeDefined();
  return (entry as OutlineEntry).id;
}

async function plainText(docId: string): Promise<string> {
  const res = await fetch(`${base}/workspaces/${WS}/docs/${docId}/content`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { plainText: string }).plainText;
}

async function pendingSuggestions(docId: string): Promise<number> {
  const res = await fetch(`${base}/workspaces/${WS}/docs/${docId}/suggestions`);
  return ((await res.json()) as { suggestions: unknown[] }).suggestions.length;
}

/**
 * A doc whose `## Meeting notes` section the Meeting Assistant wrote. The
 * notes go in through the same route and author id the note-taker's own
 * writes use, so each bullet carries its mark exactly as a meeting leaves it.
 */
async function docWithMeetingNotes(): Promise<string> {
  const docId = `notes-${seq++}`;
  const file = join(dataDir, `${docId}.md`);
  writeFileSync(file, BODY);
  const made = await post(`/workspaces/${WS}/docs`, { docId, type: 'markdown', sourceUrl: file });
  expect(made.status).toBe(200);
  const headingId = await idOf(docId, 'Meeting notes');
  const res = await blockEdits(docId, {
    author: NOTES_SUGGESTION_AUTHOR,
    edits: NOTES.map((n) => ({ op: 'insert_under_heading', headingId, markdown: `- ${n}` })),
  });
  expect(((await res.json()) as BatchResult).applied).toBe(NOTES.length);
  const marked = (await outline(docId)).filter((b) => b.author === NOTES_AUTHOR_ID);
  expect(marked.map((b) => b.text)).toEqual(NOTES);
  return docId;
}

/** A person types into the block reading `text`: a browser's edit arrives
 *  with the connection, not a string, as its origin. */
function personTypesInto(docId: string, text: string, typed: string): void {
  const ydoc = (handle.docStore.get(docId) as { ydoc: Y.Doc }).ydoc;
  const target = prose
    .addressableBlocks(prose.getProseFragment(ydoc))
    .filter((el) => prose.outlineTextOf(el) === text)
    .at(-1);
  expect(target, `no block holding "${text}"`).toBeDefined();
  let leaf: unknown = target;
  while (leaf instanceof Y.XmlElement) leaf = leaf.toArray()[0];
  expect(leaf).toBeInstanceOf(Y.XmlText);
  ydoc.transact(() => (leaf as Y.XmlText).insert(0, typed), { conn: 'browser' });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'meeting-notes-agent-edits-'));
  handle = createServer({ port: 0, dataDir });
  base = `http://127.0.0.1:${handle.port}`;
  WS = await seedBoard(base);
});

afterAll(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("an agent's edit to the Meeting Assistant's notes", () => {
  it('deletes a note no person has edited directly', async () => {
    const docId = await docWithMeetingNotes();
    const blockId = await idOf(docId, NOTES[1] as string);
    const res = await blockEdits(docId, {
      author: AGENT,
      edits: [{ op: 'delete_block', blockId }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: 1, suggested: 0, failed: 0 });
    // Asserted on the doc, not the label: the note is gone and nothing waits.
    const text = await plainText(docId);
    expect(text).not.toContain(NOTES[1] as string);
    expect(text).toContain(NOTES[0] as string);
    expect(await pendingSuggestions(docId)).toBe(0);
  });

  it('replaces a note no person has edited directly, and the new block is the agent’s', async () => {
    const docId = await docWithMeetingNotes();
    const blockId = await idOf(docId, NOTES[2] as string);
    const res = await blockEdits(docId, {
      author: AGENT,
      edits: [{ op: 'replace_block', blockId, markdown: 'Next meeting: Thursday at the dock.' }],
    });
    expect(await res.json()).toMatchObject({ applied: 1, suggested: 0 });
    const after = await outline(docId);
    expect(after.map((b) => b.text)).not.toContain(NOTES[2]);
    expect(after.find((b) => b.text === 'Next meeting: Thursday at the dock.')?.author).toBe(
      AGENT.id,
    );
    expect(await pendingSuggestions(docId)).toBe(0);
  });

  it('still proposes a delete of a note a person has edited', async () => {
    const docId = await docWithMeetingNotes();
    personTypesInto(docId, NOTES[0] as string, 'Edited: ');
    const edited = `Edited: ${NOTES[0]}`;
    const blockId = await idOf(docId, edited);
    expect((await outline(docId)).find((b) => b.id === blockId)?.author).toBeUndefined();
    const res = await blockEdits(docId, {
      author: AGENT,
      edits: [{ op: 'delete_block', blockId }],
    });
    expect(await res.json()).toMatchObject({ applied: 0, suggested: 1 });
    expect(await plainText(docId)).toContain(edited);
    expect(await pendingSuggestions(docId)).toBe(1);
  });

  it('still proposes a delete of a block a person wrote', async () => {
    const docId = await docWithMeetingNotes();
    const blockId = await idOf(docId, 'Alice wrote this agenda by hand.');
    const res = await blockEdits(docId, {
      author: AGENT,
      edits: [{ op: 'delete_block', blockId }],
    });
    expect(await res.json()).toMatchObject({ applied: 0, suggested: 1 });
    expect(await plainText(docId)).toContain('Alice wrote this agenda by hand.');
  });
});
