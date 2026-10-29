/**
 * A page that finds a comment's element with its words changed tells the
 * server, and the server keeps that copy of the anchor beside the first one.
 *
 * Driven through the real route table and a real `/y/` socket: a thread is
 * made on a mock's heading, a page reports the heading's new words through
 * `reanchor` with `refresh: true`, and another page already holding the doc
 * open sees the new words arrive with the first anchor kept. A share visitor
 * and a page relayed out of a mock frame onto a thread typed on the board are
 * refused, and their refusal changes nothing.
 *
 * Fixtures are invented. Port 0, temp data dir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Anchor, getThreads } from '@claude-workspaces/core';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';
import { waitFor } from './wait-for.ts';

const MSG_SYNC = 0;

/** A page holding the doc open: it syncs, and only listens. */
function openPage(url: string, origin: string) {
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
  return { ydoc, ready, close: () => ws.close() };
}

type ElementAnchor = Extract<Anchor, { kind: 'element' }>;

const heading = (text: string, path: string): ElementAnchor => ({
  kind: 'element',
  fingerprint: { tag: 'H3', stableAttrs: {}, classes: [], text, path, dataAttrs: {} },
  snippet: { text },
});
const FIRST = {
  ...heading('Riverbend high water by month', 'BODY[0] > MAIN[0] > H3[0]'),
  context: { url: '/report' },
};
const SEEN = heading('Riverbend high water by calendar month', 'BODY[0] > MAIN[0] > H3[1]');

describe('a refreshed anchor', () => {
  let handle: ServerHandle;
  let dataDir = '';
  let base = '';
  let ws = '';
  let other = '';
  let mock = '';
  let access: AccessHarness;
  const LOCAL = () => ({ host: `localhost:${handle.port}` });
  const PERSON = { id: 'person:reviewer', name: 'Reviewer', kind: 'person' };
  const AGENT = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
  const RELAYED = { 'x-cw-via': 'mock-frame' };

  const post = (path: string, body: unknown, headers: Record<string, string> = LOCAL()) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const ok = async (path: string, body: unknown, headers?: Record<string, string>) => {
    const res = await post(path, body, headers);
    expect(res.ok, `${path} ${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<Record<string, unknown>>;
  };
  const newThread = async (headers: Record<string, string> = LOCAL()) =>
    (
      (await ok(
        `/workspaces/${ws}/docs/${mock}/threads`,
        { author: PERSON, text: 'The heading should say which year.', anchor: FIRST },
        headers,
      )) as { thread: { id: string } }
    ).thread.id;
  const refresh = (id: string, headers: Record<string, string> = LOCAL(), anchor = SEEN) =>
    post(
      `/workspaces/${ws}/docs/${mock}/threads/${id}/reanchor`,
      { anchor, refresh: true },
      headers,
    );
  const anchorOf = async (id: string) =>
    (
      (await (
        await fetch(`${base}/workspaces/${ws}/docs/${mock}/threads/${id}`, { headers: LOCAL() })
      ).json()) as { thread: { anchor: ElementAnchor } }
    ).thread.anchor;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-anchor-refresh-'));
    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    const board = async (name: string) =>
      ((await ok('/workspaces', { name, author: AGENT })) as { workspace: { id: string } })
        .workspace.id;
    ws = await board('Saltmarsh tides');
    other = await board('Harborlight');
    const file = join(dataDir, 'report.html');
    writeFileSync(file, '<!doctype html><html><body><main><h3>Riverbend</h3></main></body></html>');
    mock = (
      (await ok(`/workspaces/${ws}/docs`, {
        docId: 'report',
        type: 'mockup',
        sourceUrl: file,
      })) as {
        docId: string;
      }
    ).docId;
    await ok(`/workspaces/${ws}/docs:attach`, { docId: mock });
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('is stored, reaches a page already open, and keeps the first anchor', async () => {
    const id = await newThread();
    const page = openPage(`ws://127.0.0.1:${handle.port}/workspaces/${ws}/docs/${mock}/y`, base);
    try {
      await page.ready;
      const live = () => getThreads(page.ydoc).get(id);
      // CONTROL: the open page holds the thread as first made, with no copy.
      expect((live()?.get('anchor') as ElementAnchor).fingerprint.text).toBe(
        'Riverbend high water by month',
      );
      expect(live()?.has('firstAnchor')).toBe(false);

      expect((await refresh(id)).status).toBe(200);

      await waitFor(
        () =>
          (live()?.get('anchor') as ElementAnchor | undefined)?.fingerprint.text ===
          'Riverbend high water by calendar month',
        { describe: 'the refreshed anchor on the open page' },
      );
      expect(live()?.get('firstAnchor')).toEqual(FIRST);
      const stored = await anchorOf(id);
      expect(stored.fingerprint).toEqual(SEEN.fingerprint);
      // The page it was made on is the thread's, whatever the report says.
      expect(stored.context).toEqual({ url: '/report' });
    } finally {
      page.close();
    }
  });

  it('refuses another tag, and a thread that is not on an element', async () => {
    const id = await newThread();
    const res = await refresh(id, LOCAL(), {
      ...SEEN,
      fingerprint: { ...SEEN.fingerprint, tag: 'P' },
    });
    expect(res.status).toBe(409);
    expect((await anchorOf(id)).fingerprint.text).toBe('Riverbend high water by month');
    const subject = (
      (await ok(`/workspaces/${ws}/docs/${mock}/threads`, {
        author: PERSON,
        text: 'About the whole report.',
        anchor: { kind: 'subject' },
      })) as { thread: { id: string } }
    ).thread.id;
    expect((await refresh(subject)).status).toBe(409);
  });

  it('is refused to a share visitor, on this board or another, and changes nothing', async () => {
    const id = await newThread();
    for (const board of [ws, other]) {
      const share = await mintAccessShare(
        base,
        { ...access, shareLinks: handle.shareLinks },
        board,
      );
      const res = await refresh(id, share.headers);
      expect(
        res.status,
        `a visitor on ${board === ws ? 'this' : 'another'} board`,
      ).toBeGreaterThanOrEqual(400);
    }
    expect((await anchorOf(id)).fingerprint.text).toBe('Riverbend high water by month');
    // CONTROL: the same visitor on this board may still reply on the thread.
    const share = await mintAccessShare(base, { ...access, shareLinks: handle.shareLinks }, ws);
    const reply = await post(
      `/workspaces/${ws}/docs/${mock}/threads/${id}/comments`,
      { text: 'Agreed.' },
      share.headers,
    );
    expect(reply.status).toBe(200);
  });

  it('is refused to a mock frame on a thread typed on the board, and taken on one typed in it', async () => {
    const typed = await newThread();
    expect((await refresh(typed, { ...LOCAL(), ...RELAYED })).status).toBe(403);
    expect((await anchorOf(typed)).fingerprint.text).toBe('Riverbend high water by month');
    const framed = await newThread({ ...LOCAL(), ...RELAYED });
    expect((await refresh(framed, { ...LOCAL(), ...RELAYED })).status).toBe(200);
    expect((await anchorOf(framed)).fingerprint.text).toBe(
      'Riverbend high water by calendar month',
    );
  });
});
