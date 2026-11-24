/**
 * Reading a doc's outline changes nothing on disk.
 *
 * A `.ydoc` saved before blocks got their ids on write holds blocks with no
 * `cwId`. The outline used to mint those ids as it read, so the first
 * `GET …/outline` wrote the `.ydoc`. Now such a block answers to an id derived
 * from its Yjs identity, and the id reaches disk only with a write.
 *
 * The fixture is that legacy file: a doc the server made, with its ids
 * stripped while the server is stopped, then loaded by a fresh server.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { pastWriteBack, waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

interface OutlineBody {
  blocks: { id: string; text: string }[];
}

describe('GET …/outline on a doc whose blocks have no ids', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let fileDir: string;
  let base: string;
  let ws: string;
  let docId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'outline-read-data-'));
    fileDir = mkdtempSync(join(tmpdir(), 'outline-read-files-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base, { name: 'Harborlight' });
    const md = join(fileDir, 'riverbend.md');
    writeFileSync(md, '# Riverbend\n\nA paragraph.\n\n- one bullet\n- two bullet\n');
    const res = await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'riverbend', type: 'markdown', sourceUrl: md }),
    });
    expect(res.status).toBe(200);
    docId = ((await res.json()) as { docId: string }).docId;
    const path = await settledYdoc();
    await handle.stop();

    const legacy = new Y.Doc();
    Y.applyUpdate(legacy, readFileSync(path));
    const blocks = prose.addressableBlocks(prose.getProseFragment(legacy));
    expect(blocks.some((el) => prose.readBlockId(el) !== undefined)).toBe(true);
    legacy.transact(() => {
      for (const el of blocks) el.removeAttribute(prose.BLOCK_ID_ATTR);
    });
    writeFileSync(path, Y.encodeStateAsUpdate(legacy));

    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fileDir, { recursive: true, force: true });
  });

  const ydocPath = (): string | undefined => {
    const walk = (dir: string): string | undefined => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, ent.name);
        if (ent.isDirectory()) {
          const hit = walk(abs);
          if (hit) return hit;
        } else if (ent.name === `${docId}.ydoc`) return abs;
      }
      return undefined;
    };
    return walk(dataDir);
  };

  const docFrom = (path: string): Y.Doc => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, readFileSync(path));
    return doc;
  };

  const sha = (path: string): string =>
    createHash('sha256').update(readFileSync(path)).digest('hex');

  /** The doc's `.ydoc` once two reads a write-back apart agree. */
  const settledYdoc = (): Promise<string> =>
    waitFor(
      async () => {
        const path = ydocPath();
        if (!path) return false;
        const a = sha(path);
        // timed: one write-back window, the debounce a write can still be inside.
        await new Promise((r) => setTimeout(r, pastWriteBack()));
        return sha(path) === a ? path : false;
      },
      { describe: 'the doc to stop writing its .ydoc' },
    );

  const outline = async (): Promise<OutlineBody> => {
    const res = await fetch(`${base}/workspaces/${ws}/docs/${docId}/outline`);
    expect(res.status).toBe(200);
    return (await res.json()) as OutlineBody;
  };

  it('leaves the .ydoc byte for byte as it was, and hands out the same ids twice', async () => {
    const path = ydocPath() as string;
    const before = sha(path);
    expect(
      prose
        .addressableBlocks(prose.getProseFragment(docFrom(path)))
        .map((el) => prose.readBlockId(el)),
    ).toEqual([undefined, undefined, undefined, undefined, undefined]);

    const first = await outline();
    const second = await outline();
    expect(first.blocks.map((b) => b.text)).toEqual([
      'Riverbend',
      'A paragraph.',
      'one bullet',
      'two bullet',
    ]);
    expect(new Set(first.blocks.map((b) => b.id)).size).toBe(first.blocks.length);
    expect(second.blocks.map((b) => b.id)).toEqual(first.blocks.map((b) => b.id));

    // timed: one write-back window, so a write the read scheduled has landed.
    await new Promise((r) => setTimeout(r, pastWriteBack()));
    expect(sha(ydocPath() as string)).toBe(before);
  });

  it('an edit names a block by the id the read handed out, and that id holds after', async () => {
    const { blocks } = await outline();
    const heading = blocks.find((b) => b.text === 'Riverbend');
    expect(heading).toBeDefined();
    const res = await fetch(`${base}/workspaces/${ws}/docs/${docId}/block_edits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: { id: 'agent-bob', name: 'Bob' },
        edits: [{ op: 'insert_under_heading', headingId: heading?.id, markdown: 'Added by Bob.' }],
      }),
    });
    const body = (await res.json()) as { applied?: number };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.applied).toBe(1);
    const after = await outline();
    expect(after.blocks.map((b) => b.text)).toEqual([
      'Riverbend',
      'A paragraph.',
      'one bullet',
      'two bullet',
      'Added by Bob.',
    ]);
    // The write persisted the heading's id as the one the read handed out.
    expect(after.blocks.find((b) => b.text === 'Riverbend')?.id).toBe(heading?.id as string);
    expect(after.blocks.map((b) => b.id).slice(0, 4)).toEqual(blocks.map((b) => b.id));
  });
});
