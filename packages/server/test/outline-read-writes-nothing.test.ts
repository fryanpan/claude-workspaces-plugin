/**
 * Reading a doc's outline changes nothing on disk.
 *
 * A doc parsed from markdown holds blocks with no `cwId`. The outline used to
 * mint those ids as it read, so the first `GET …/outline` wrote the `.ydoc`.
 * Now an id-less block is reported under an id derived from its Yjs identity,
 * and the id is persisted only when an edit writes the doc.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  const sha = (path: string): string =>
    createHash('sha256').update(readFileSync(path)).digest('hex');

  const outline = async (): Promise<OutlineBody> => {
    const res = await fetch(`${base}/workspaces/${ws}/docs/${docId}/outline`);
    expect(res.status).toBe(200);
    return (await res.json()) as OutlineBody;
  };

  it('leaves the .ydoc byte for byte as it was, and hands out the same ids twice', async () => {
    // The create persists the .ydoc on its own debounce; wait until two reads
    // a write-back apart agree before taking the snapshot.
    const before = await waitFor(
      async () => {
        const path = ydocPath();
        if (!path) return false;
        const a = sha(path);
        // timed: one write-back window, the debounce the create can still be inside.
        await new Promise((r) => setTimeout(r, pastWriteBack()));
        return sha(path) === a ? a : false;
      },
      { describe: 'the created doc to stop writing its .ydoc' },
    );

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
