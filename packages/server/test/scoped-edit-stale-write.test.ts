import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { getProseFragment } from '../../core/src/prose.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

/**
 * A person formats a table cell in the editor — a line break, a bullet list —
 * and an agent then edits the doc with a scoped tool. On 2026-10-14 that edit
 * flattened the cell and left no backup. Two guarantees are pinned here:
 *
 *  1. A scoped edit on a doc a person edited inside the window first writes a
 *     backup, and the backup keeps the cell's structure.
 *  2. A scoped edit that changes a block a person changed after the agent's
 *     last read is refused with set_doc_content's 409 stale-write, and
 *     `confirmOverwriteHumanEdits` lets it through. An edit to any OTHER block
 *     lands, so editing alongside a person keeps working.
 */

const MSG_SYNC = 0;

/** Minimal Yjs browser-client stand-in (same framing as ws.test.ts). */
function connectDoc(url: string): { ws: WebSocket; ydoc: Y.Doc; ready: Promise<void> } {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((r) => {
    resolveReady = r;
  });
  let synced = false;
  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
    if (decoding.readVarUint(dec) !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (
      !synced &&
      (type === syncProtocol.messageYjsSyncStep2 || type === syncProtocol.messageYjsUpdate)
    ) {
      synced = true;
      resolveReady?.();
    }
  });
  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });
  return { ws, ydoc, ready };
}

const DOC = `# Stops

Intro paragraph.

| Stop | Notes |
| --- | --- |
| Harborlight | first |

Closing paragraph.
`;

const AGENT = { id: 'agent-scoped-1', name: 'Scoped Agent', color: '#123456', kind: 'known' };

let WS = '';

describe('scoped edits under the stale-write rule', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let canonicalId: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-scoped-stale-'));
    const path = join(dataDir, 'doc.md');
    writeFileSync(path, DOC);
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
    const create = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 's1', type: 'markdown', sourceUrl: path }),
    });
    expect(create.ok).toBe(true);
    canonicalId = ((await create.json()) as { docId: string }).docId;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** In the browser editor, put a line break and a bullet list into the
   *  table's "first" cell, and wait until the server has seen it. */
  async function humanFormatsCell(): Promise<void> {
    const before = handle.docStore.staleWriteCheck('s1')?.humanEditedAt ?? 0;
    const client = connectDoc(`ws://127.0.0.1:${handle.port}/workspaces/${WS}/docs/s1/y`);
    await client.ready;
    const table = getProseFragment(client.ydoc)
      .toArray()
      .find((n) => n instanceof Y.XmlElement && n.nodeName === 'table') as Y.XmlElement;
    const row = table.toArray()[1] as Y.XmlElement;
    const cell = row.toArray()[1] as Y.XmlElement;
    const para = cell.toArray()[0] as Y.XmlElement;
    client.ydoc.transact(() => {
      para.insert(para.length, [new Y.XmlElement('hardBreak'), new Y.XmlText('Saltmarsh')]);
      const item = new Y.XmlElement('listItem');
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText('Riverbend')]);
      item.insert(0, [p]);
      const list = new Y.XmlElement('bulletList');
      list.insert(0, [item]);
      cell.insert(cell.length, [list]);
    });
    await waitFor(
      () => {
        const at = handle.docStore.staleWriteCheck('s1')?.humanEditedAt;
        return at !== undefined && at > before;
      },
      { describe: 'the server to stamp the human edit' },
    );
    client.ws.close();
  }

  async function post(
    route: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}/workspaces/${WS}/docs/s1/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  async function agentReads(): Promise<void> {
    const read = await fetch(`${base}/workspaces/${WS}/docs/s1/content?reader=${AGENT.id}`);
    expect(read.ok).toBe(true);
    await read.arrayBuffer();
  }

  async function docText(): Promise<string> {
    const res = await fetch(`${base}/workspaces/${WS}/docs/s1/content`);
    return res.text();
  }

  function backups(): string[] {
    try {
      return readdirSync(join(dataDir, 'backups', canonicalId))
        .filter((f) => f.endsWith('.md'))
        .sort();
    } catch {
      return [];
    }
  }

  it('backs the doc up before a scoped edit lands after a human edit, keeping the cell', async () => {
    await humanFormatsCell();
    await agentReads();
    const res = await post('find_and_replace', {
      find: 'Closing paragraph.',
      replace: 'Closing paragraph, edited.',
      author: AGENT,
    });
    expect(res.status).toBe(200);
    expect(typeof res.json.backup).toBe('string');
    const files = backups();
    expect(files.length).toBe(1);
    const saved = readFileSync(join(dataDir, 'backups', canonicalId, files[0] ?? ''), 'utf8');
    expect(saved).toContain('| first<br>Saltmarsh<br><br>- Riverbend |');
    expect(saved).toContain('Closing paragraph.');

    // A second agent edit with no new human edit between writes no second
    // backup: the person's version is already saved.
    const again = await post('find_and_replace', {
      find: 'Intro paragraph.',
      replace: 'Intro paragraph, edited.',
      author: AGENT,
    });
    expect(again.status).toBe(200);
    expect(again.json.backup).toBeUndefined();
    expect(backups().length).toBe(1);
  });

  it('an idle doc gets no backup from a scoped edit', async () => {
    const res = await post('find_and_replace', {
      find: 'Closing paragraph.',
      replace: 'Closing paragraph, edited.',
      author: AGENT,
    });
    expect(res.status).toBe(200);
    expect(backups().length).toBe(0);
  });

  it('refuses an edit to the block a human changed after the agent read', async () => {
    await agentReads();
    await humanFormatsCell();
    const res = await post('find_and_replace', {
      find: 'Harborlight',
      replace: 'Harborlight Quay',
      author: AGENT,
    });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('stale-write');
    expect(typeof res.json.humanEditedAt).toBe('number');
    expect(typeof res.json.lastReadAt).toBe('number');
    expect(String(res.json.message)).toContain('confirmOverwriteHumanEdits');
    const text = await docText();
    expect(text).not.toContain('Harborlight Quay');
    expect(text).toContain('Saltmarsh');
  });

  it('confirmOverwriteHumanEdits lets the same edit through', async () => {
    await agentReads();
    await humanFormatsCell();
    const res = await post('find_and_replace', {
      find: 'Harborlight',
      replace: 'Harborlight Quay',
      author: AGENT,
      confirmOverwriteHumanEdits: true,
    });
    expect(res.status).toBe(200);
    const text = await docText();
    expect(text).toContain('Harborlight Quay');
    expect(text).toContain('Saltmarsh');
  });

  it('an edit to a block the human did not touch lands', async () => {
    await agentReads();
    await humanFormatsCell();
    const res = await post('find_and_replace', {
      find: 'Closing paragraph.',
      replace: 'Closing paragraph, edited.',
      author: AGENT,
    });
    expect(res.status).toBe(200);
    expect(await docText()).toContain('Closing paragraph, edited.');
  });

  it('a re-read after the human edit clears the refusal', async () => {
    await agentReads();
    await humanFormatsCell();
    await agentReads();
    const res = await post('find_and_replace', {
      find: 'Harborlight',
      replace: 'Harborlight Quay',
      author: AGENT,
    });
    expect(res.status).toBe(200);
  });

  it('a caller with no tracked read is judged by the window, block by block', async () => {
    await humanFormatsCell();
    const refused = await post('find_and_replace', { find: 'Harborlight', replace: 'Riverbend' });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('stale-write');
    const elsewhere = await post('find_and_replace', {
      find: 'Intro paragraph.',
      replace: 'Intro, edited.',
    });
    expect(elsewhere.status).toBe(200);
  });

  it('the other scoped routes are guarded too: an anchor edit and a range delete', async () => {
    const anchor = await post('agent_anchors', { find: 'first' });
    expect(anchor.status).toBe(200);
    const anchorId = String(anchor.json.anchorId);
    await agentReads();
    await humanFormatsCell();
    const edit = await post(`agent_anchors/${encodeURIComponent(anchorId)}/edit`, {
      kind: 'replace',
      text: 'second',
      author: AGENT,
    });
    expect(edit.status).toBe(409);
    expect(edit.json.error).toBe('stale-write');
    const del = await post('delete_blocks_in_range', {
      startFind: 'Intro paragraph.',
      endFind: 'Closing paragraph.',
      author: AGENT,
    });
    expect(del.status).toBe(409);
    expect(await docText()).toContain('Saltmarsh');
  });
});
