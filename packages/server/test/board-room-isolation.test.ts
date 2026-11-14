/**
 * A connection to one board's room hears nothing from another board's room,
 * and cannot write into it.
 *
 * Step 1 of the collaboration-core plan reuses the room transport as is, so
 * this is the property it inherits. The refusals at the upgrade are already
 * asserted one transport at a time (`board-share.test.ts` "refuses the socket
 * to another workspace's visitor", `collab-host.test.ts` "refuses the DOCS of
 * a board it was not given"). What neither drives is an OPEN socket while the
 * other board changes: that is the receive half here, with the write half
 * restated beside it so the property reads as one test.
 *
 * The visitor is a share visitor on board Harborlight: the local owner is
 * trusted with every board by design, so it cannot be the subject.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import {
  ACCESS_BASE_HOSTNAME,
  type AccessHarness,
  accessHarness,
  mintAccessShare,
} from './access-share.ts';
import { waitFor } from './wait-for.ts';

const PERSON = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const MSG_SYNC = 0;

/** A real Yjs client that also keeps every raw frame it was sent. */
function connectRoom(url: string, headers: Record<string, string>) {
  const ydoc = new Y.Doc();
  const frames: Uint8Array[] = [];
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let synced = false;
  ws.addEventListener('open', () => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, ydoc);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.addEventListener('message', (ev) => {
    const data = new Uint8Array(ev.data as ArrayBuffer);
    frames.push(data);
    const dec = decoding.createDecoder(data);
    if (decoding.readVarUint(dec) !== MSG_SYNC) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const type = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    if (type === syncProtocol.messageYjsSyncStep2) synced = true;
  });
  return { ws, ydoc, frames, isSynced: () => synced };
}

const taskTitles = (ydoc: Y.Doc): string[] =>
  [...ydoc.getMap('tasks').values()].map((t) => String((t as { title?: unknown }).title));

describe('board rooms are isolated from each other', () => {
  let handle: ServerHandle;
  let access: AccessHarness;
  let dataDir: string;
  let base: string;
  let harborlight: string;
  let riverbend: string;
  let riverbendDoc: string;
  let visitor: Record<string, string>;

  const local = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const asVisitor = (path: string) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      headers: { host: ACCESS_BASE_HOSTNAME, ...visitor },
    });
  const createBoard = async (name: string): Promise<string> => {
    const r = await local('/workspaces', { name });
    expect(r.status).toBe(200);
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  };
  const createTask = async (board: string, title: string): Promise<void> => {
    expect((await local(`/workspaces/${board}/tasks`, { author: PERSON, title })).status).toBe(200);
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'board-room-isolation-'));
    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    harborlight = await createBoard('harborlight');
    riverbend = await createBoard('riverbend');
    await createTask(harborlight, 'Harborlight first task');

    const path = join(dataDir, 'riverbend-plan.md');
    writeFileSync(path, '# Riverbend plan\n\nBody.\n');
    const d = await local(`/workspaces/${riverbend}/docs`, {
      docId: 'riverbend-plan',
      type: 'markdown',
      sourceUrl: path,
    });
    expect(d.status).toBe(200);
    riverbendDoc = ((await d.json()) as { docId: string }).docId;

    visitor = (
      await mintAccessShare(base, { ...access, shareLinks: handle.shareLinks }, harborlight, {
        label: 'harborlight share',
      })
    ).headers;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("an open socket on one board receives nothing when another board's room changes", async () => {
    const room = connectRoom(`ws://127.0.0.1:${handle.port}/workspaces/${harborlight}/y`, visitor);
    // Positive control: a socket on Riverbend's own room DOES receive the
    // change, so its absence below is isolation and not a change never sent.
    const other = connectRoom(`ws://127.0.0.1:${handle.port}/workspaces/${riverbend}/y`, {
      host: `localhost:${handle.port}`,
    });
    try {
      await waitFor(() => other.isSynced(), { describe: 'the owner socket on Riverbend to sync' });
      await waitFor(
        () => room.isSynced() && taskTitles(room.ydoc).includes('Harborlight first task'),
        {
          describe: 'the visitor socket to sync its own board',
        },
      );

      // Riverbend changes FIRST, then Harborlight. The room broadcasts in
      // order, so once the Harborlight change has arrived, a Riverbend frame
      // routed to this socket would already be here.
      await createTask(riverbend, 'Riverbend secret task');
      await waitFor(() => taskTitles(other.ydoc).includes('Riverbend secret task'), {
        describe: 'the Riverbend change to reach Riverbend’s own room',
      });
      await createTask(harborlight, 'Harborlight second task');
      await waitFor(() => taskTitles(room.ydoc).includes('Harborlight second task'), {
        describe: 'the later change on the visitor’s own board to arrive',
      });

      expect(taskTitles(room.ydoc)).not.toContain('Riverbend secret task');
      const needle = new TextEncoder().encode('Riverbend secret task');
      const carries = (frame: Uint8Array) =>
        frame.some((_, i) => needle.every((b, j) => frame[i + j] === b));
      // Positive control for the byte search: the own-board title IS found.
      const own = new TextEncoder().encode('Harborlight second task');
      expect(room.frames.some((f) => f.some((_, i) => own.every((b, j) => f[i + j] === b)))).toBe(
        true,
      );
      expect(room.frames.some(carries)).toBe(false);
    } finally {
      room.ws.close();
      other.ws.close();
    }
  });

  it("refuses that visitor every socket into the other board's room and docs", async () => {
    // Positive control: the same credentials pass the gate on their own
    // board (426 = past every check, upgrade required on a plain fetch).
    expect((await asVisitor(`/workspaces/${harborlight}/y`)).status).toBe(426);

    // The other board's room, and its doc by its own address.
    expect((await asVisitor(`/workspaces/${riverbend}/y`)).status).toBe(403);
    expect((await asVisitor(`/workspaces/${riverbend}/docs/${riverbendDoc}/y`)).status).toBe(403);
    // Its doc addressed under the visitor's own board: the share guard asks
    // whether the board holds the doc, so naming your own board does not
    // open another board's doc.
    expect((await asVisitor(`/workspaces/${harborlight}/docs/${riverbendDoc}/y`)).status).toBe(403);
  });
});
