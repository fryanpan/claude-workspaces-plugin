/**
 * A pick on a ```choice block, made in one open editor, reaches another open
 * editor, is written to the bound `.md`, is returned by the read `get_doc`
 * makes, and is still there after a restart.
 *
 * Driven end to end: a real server and two real `/y/` sockets speaking the
 * Yjs protocol the editor speaks. The pick is made the way the editor makes
 * it, as a text edit inside the block (`setChoicePick`). Waits poll the
 * observable; the write-back cadence is the scaled one every server test
 * runs under. Fixtures are invented. Port 0, temp data dir.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { CHOICE_LANGUAGE, parseChoice, setChoicePick } from '../../core/src/prose-choice.ts';
import { getProseFragment } from '../../core/src/prose.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor, waitForFile } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const MSG_SYNC = 0;

const DOC = [
  '# Leads',
  '',
  'Riverbend runs the harbour office.',
  '',
  '```choice',
  'id=lead-riverbend options="yes,maybe,no"',
  '```',
  '',
].join('\n');
const PICKED = DOC.replace('options="yes,maybe,no"', 'options="yes,maybe,no" picked=yes');

/** The editor's side of the socket: sync, and its own edits sent on. */
function connectEditor(url: string, origin: string) {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(url, { headers: { origin } } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  let synced: () => void = () => {};
  const ready = new Promise<void>((r) => {
    synced = r;
  });
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
    if (type === syncProtocol.messageYjsSyncStep2) synced();
  });
  ydoc.on('update', (update: Uint8Array, from: unknown) => {
    if (from === ws || ws.readyState !== WebSocket.OPEN) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });
  return { ydoc, ready, close: () => ws.close() };
}

/** The choice block's text in a client's copy of the doc, or null. */
function choiceText(ydoc: Y.Doc): Y.XmlText | null {
  const el = (getProseFragment(ydoc).toArray() as Y.XmlElement[]).find(
    (n) =>
      n instanceof Y.XmlElement &&
      n.nodeName === 'codeBlock' &&
      n.getAttribute('language') === CHOICE_LANGUAGE,
  );
  const t = el?.get(0);
  return t instanceof Y.XmlText ? t : null;
}

describe('a pick on a choice block', () => {
  let handle: ServerHandle | null = null;
  let dataDir = '';
  const sockets: Array<{ close: () => void }> = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await handle?.stop();
    handle = null;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reaches another open page, the file and get_doc, and survives a restart', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-doc-choice-'));
    const path = join(dataDir, 'leads.md');
    writeFileSync(path, DOC);
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    let base = `http://127.0.0.1:${handle.port}`;
    const ws = await seedBoard(base);
    const created = await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'leads', type: 'markdown', sourceUrl: path }),
    });
    expect(created.ok).toBe(true);

    const socketUrl = () => `ws://127.0.0.1:${handle?.port}/workspaces/${ws}/docs/leads/y`;
    const a = connectEditor(socketUrl(), base);
    const b = connectEditor(socketUrl(), base);
    sockets.push(a, b);
    await Promise.all([a.ready, b.ready]);
    expect(parseChoice(choiceText(b.ydoc)?.toString() ?? '')?.picked).toBeUndefined();

    // A taps "yes".
    const text = choiceText(a.ydoc);
    if (!text) throw new Error('no choice block on page A');
    a.ydoc.transact(() => {
      const next = setChoicePick(text.toString(), 'yes');
      text.delete(0, text.length);
      text.insert(0, next);
    });

    // B, already open, shows it without a reload.
    await waitFor(() => parseChoice(choiceText(b.ydoc)?.toString() ?? '')?.picked === 'yes', {
      describe: 'the pick on the other open page',
    });

    // The bound file gets it, and so does the read get_doc makes.
    await waitForFile(path, (t) => t === PICKED);
    const content = async () =>
      JSON.stringify(await (await fetch(`${base}/workspaces/${ws}/docs/leads/content`)).json());
    expect(await content()).toContain('picked=yes');

    // A restart keeps it.
    for (const s of sockets.splice(0)) s.close();
    await handle.stop();
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    base = `http://127.0.0.1:${handle.port}`;
    expect(await content()).toContain('picked=yes');
    const c = connectEditor(socketUrl(), base);
    sockets.push(c);
    await c.ready;
    expect(parseChoice(choiceText(c.ydoc)?.toString() ?? '')?.picked).toBe('yes');
  });
});
