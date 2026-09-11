import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@claude-workspaces/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitForFileToBe } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

/**
 * Markdown an agent writes into a PROPOSAL reaches the doc as marks.
 *
 * The core primitives decide that (`suggest-ops.ts`), but a route that reads
 * the field as `body.parseInlineMarks === true` re-imposes the old
 * literal-characters behaviour on every caller that omits it — the shape the
 * route-layer learnings are about, and invisible to a core unit test. So both
 * suggest routes are driven here over real HTTP, and the proposed text is read
 * back off the doc's own suggestion list.
 *
 * `insertedText` is the plain text of the offered run, so a tag that parsed
 * reads `@Riverbend` and one that did not reads the whole bracket-and-paren
 * spelling. That difference is the bug this file pins.
 */

const author: User = { id: 'agent-1', name: 'Note Taker', kind: 'known', color: '#7c5cff' };
const SPEAKER_TAG = '[@Riverbend](speaker:A)';

let WS = '';

describe('a proposal offers markdown as marks', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-suggest-inline-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function j<T>(res: Response): Promise<T> {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  }

  async function makeDoc(docId: string, md: string): Promise<string> {
    const file = join(dataDir, `${docId}.md`);
    writeFileSync(file, md);
    await j(
      await fetch(`${base}/workspaces/${WS}/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
      }),
    );
    return file;
  }

  /** The text every pending proposal on `docId` offers. */
  async function offeredText(docId: string): Promise<string[]> {
    const list = await j<{ suggestions: Array<{ insertedText: string }> }>(
      await fetch(`${base}/workspaces/${WS}/docs/${docId}/suggestions`),
    );
    return list.suggestions.map((s) => s.insertedText);
  }

  it('find_and_replace with suggest:true offers a speaker tag as the tag, not as brackets', async () => {
    await makeDoc('sug-md-far', 'Somebody asked about the gate.\n');
    await j(
      await fetch(`${base}/workspaces/${WS}/docs/sug-md-far/find_and_replace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          find: 'Somebody',
          replace: SPEAKER_TAG,
          suggest: true,
          author,
        }),
      }),
    );
    expect(await offeredText('sug-md-far')).toEqual(['@Riverbend']);
  });

  it('find_and_replace with suggest:true honours an explicit parseInlineMarks:false', async () => {
    await makeDoc('sug-md-far-off', 'Somebody asked about the gate.\n');
    await j(
      await fetch(`${base}/workspaces/${WS}/docs/sug-md-far-off/find_and_replace`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          find: 'Somebody',
          replace: SPEAKER_TAG,
          suggest: true,
          parseInlineMarks: false,
          author,
        }),
      }),
    );
    expect(await offeredText('sug-md-far-off')).toEqual([SPEAKER_TAG]);
  });

  it('rewrite_region with suggest:true offers a speaker tag as the tag', async () => {
    await makeDoc('sug-md-region', 'Somebody asked about the gate.\n');
    const thread = await j<{ thread: { id: string } }>(
      await fetch(`${base}/workspaces/${WS}/docs/sug-md-region/threads/by_find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author, text: 'who asked?', find: 'Somebody' }),
      }),
    );
    await j(
      await fetch(
        `${base}/workspaces/${WS}/docs/sug-md-region/threads/${thread.thread.id}/rewrite_region`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ replacement: SPEAKER_TAG, suggest: true, author }),
        },
      ),
    );
    expect(await offeredText('sug-md-region')).toEqual(['@Riverbend']);
  });

  it('rewrite_region with suggest:true honours an explicit parseInlineMarks:false', async () => {
    await makeDoc('sug-md-region-off', 'Somebody asked about the gate.\n');
    const thread = await j<{ thread: { id: string } }>(
      await fetch(`${base}/workspaces/${WS}/docs/sug-md-region-off/threads/by_find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author, text: 'who asked?', find: 'Somebody' }),
      }),
    );
    await j(
      await fetch(
        `${base}/workspaces/${WS}/docs/sug-md-region-off/threads/${thread.thread.id}/rewrite_region`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            replacement: SPEAKER_TAG,
            suggest: true,
            parseInlineMarks: false,
            author,
          }),
        },
      ),
    );
    expect(await offeredText('sug-md-region-off')).toEqual([SPEAKER_TAG]);
  });

  it('the direct (non-suggest) rewrite_region is unchanged: an omitted flag still writes characters', async () => {
    const file = await makeDoc('sug-md-direct', 'Somebody asked about the gate.\n');
    const thread = await j<{ thread: { id: string } }>(
      await fetch(`${base}/workspaces/${WS}/docs/sug-md-direct/threads/by_find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author, text: 'who asked?', find: 'Somebody' }),
      }),
    );
    await j(
      await fetch(
        `${base}/workspaces/${WS}/docs/sug-md-direct/threads/${thread.thread.id}/rewrite_region`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ replacement: '3 * 4 people' }),
        },
      ),
    );
    await waitForFileToBe(file, '3 * 4 people asked about the gate.\n');
  });
});
