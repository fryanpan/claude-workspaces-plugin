/**
 * A person's edits in the browser editor and an agent's edits through the
 * REST edit tools each close into their own `edit_session` row in
 * `activity.jsonl` — with times and sizes, and never the words.
 *
 * Driven end to end: a real server, a real `/y/` socket speaking the Yjs
 * protocol the editor speaks, and the same `find_and_replace` route the MCP
 * tool calls. The idle window is shortened through `editSessionIdleMs`, so a
 * session closes in a fraction of a second instead of a minute; the rows are
 * waited for, never slept for.
 *
 * All fixtures are invented. Port 0, temp data dir.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { getProseFragment } from '../../core/src/prose.ts';
import { activityLogPath } from '../src/activity.ts';
import type { Event } from '../src/activity.ts';
import { ownerDisplayNames } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/** Long enough that two transactions sent back to back always share a
 *  session, short enough that a test waits well under a second for it. */
const IDLE_MS = 250;

const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Words that must never reach the activity log. */
const TYPED = 'Harborlight tide tables';
const TYPED_MORE = ' for Riverbend';

const DOC = '# Tides\n\nIntro paragraph.\n';

// The server prints a login code only when told to; the sign-in below reads it.
process.env.CW_LOG_LOGIN_CODES = '1';

/** Login codes the server prints, captured so a test can sign in the way a
 *  browser does. Fixture addresses only. */
const codes: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  const m = args
    .map(String)
    .join(' ')
    .match(/login code for \S+: (\d{6})/);
  if (m?.[1]) codes.push(m[1]);
  originalLog(...(args as []));
};

/** What a browser's request carries on the wire. */
const browserHeaders = (base: string): Record<string, string> => ({
  origin: base,
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
});

/** Sign in with an emailed code; returns the session cookie pair. */
async function signIn(base: string, email: string): Promise<string> {
  const before = codes.length;
  const started = await fetch(`${base}/api/auth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...browserHeaders(base) },
    body: JSON.stringify({ email }),
  });
  expect(started.status).toBe(200);
  expect(codes.length).toBe(before + 1);
  const res = await fetch(`${base}/api/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...browserHeaders(base) },
    body: JSON.stringify({ email, code: codes[codes.length - 1] }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

/** The editor's side of the socket: sync, presence, and its own edits sent on. */
function connectEditor(url: string, name: string, origin: string, cookie?: string) {
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  // Bun's client takes headers; the DOM typing for WebSocket does not know that.
  const ws = new WebSocket(url, {
    headers: { origin, 'user-agent': IPAD_UA, ...(cookie ? { cookie } : {}) },
  } as unknown as string[]);
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
    awareness.setLocalStateField('user', { name, color: '#336699' });
    const aw = encoding.createEncoder();
    encoding.writeVarUint(aw, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      aw,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [ydoc.clientID]),
    );
    ws.send(encoding.toUint8Array(aw));
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
  return {
    ydoc,
    ready,
    close: () => {
      awareness.destroy();
      ws.close();
    },
  };
}

type Frame = { event: string };

/** Collect SSE event names off an open response until stopped. */
function listen(res: Response): { frames: Frame[]; stop: () => void } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  void (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          if (raw.startsWith(':')) continue;
          const line = raw.split('\n').find((l) => l.startsWith('event:'));
          frames.push({ event: line ? line.slice(6).trim() : 'message' });
        }
      }
    } catch {
      // Cancelled with a read in flight; the frames collected still stand.
    }
  })();
  return {
    frames,
    stop: () => {
      stopped = true;
      void reader.cancel();
    },
  };
}

function editRows(dataDir: string): Event[] {
  let raw = '';
  try {
    raw = readFileSync(activityLogPath(dataDir), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Event)
    .filter((e) => e.type === 'edit_session');
}

describe('edit_session activity rows', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let WS = '';
  let docId = '';
  let cookie = '';

  async function boot(requireSignInToWrite: boolean): Promise<void> {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-edit-session-'));
    const path = join(dataDir, 'tides.md');
    writeFileSync(path, DOC);
    handle = createServer({
      port: 0,
      dataDir,
      editSessionIdleMs: IDLE_MS,
      emailCodeSignIn: true,
      requireSignInToWrite,
    });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
    const created = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'tides', type: 'markdown', sourceUrl: path }),
    });
    expect(created.ok).toBe(true);
    docId = ((await created.json()) as { docId: string }).docId;
    cookie = requireSignInToWrite ? await signIn(base, 'alice@example.com') : '';
  }

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Two transactions from the browser: a new paragraph with text, then more
   *  text typed into it. */
  async function humanTypes(): Promise<void> {
    const editor = connectEditor(
      `ws://127.0.0.1:${handle.port}/workspaces/${WS}/docs/tides/y`,
      'Bob',
      base,
      cookie || undefined,
    );
    await editor.ready;
    const frag = getProseFragment(editor.ydoc);
    const text = new Y.XmlText();
    editor.ydoc.transact(() => {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [text]);
      frag.push([p]);
      text.insert(0, TYPED);
    });
    editor.ydoc.transact(() => text.insert(TYPED.length, TYPED_MORE));
    // Wait until the server holds both edits before the socket goes.
    await waitFor(() => handle.docStore.staleWriteCheck('tides') !== null);
    await waitFor(() => (handle.docStore.editSessions.openCount() > 0 ? true : null));
    editor.close();
  }

  it('writes one row for a human editing session, with times and sizes and no text', async () => {
    await boot(true);
    await humanTypes();
    const [row] = await waitFor(() => {
      const rows = editRows(dataDir);
      return rows.length > 0 ? rows : null;
    });
    // Nothing else closes after it: the idle window has passed with one session.
    expect(editRows(dataDir)).toHaveLength(1);
    expect(row).toBeDefined();
    const r = row as Event;
    expect(r.actor).toBe('person');
    // The signed-in identity, not the name the page's presence announced.
    expect(r.actorId).toMatch(/^user-/);
    expect(r.actorName).not.toBe('Bob');
    expect(r.doc.docId).toBe(docId);
    expect(r.device).toEqual({ kind: 'ipad', browser: 'Safari' });
    expect(r.payload.source).toBe('editor');
    expect(r.payload.editCount).toBe(2);
    expect(r.payload.charsInserted ?? 0).toBeGreaterThanOrEqual(TYPED.length + TYPED_MORE.length);
    expect(r.payload.charsDeleted).toBe(0);
    // The second transaction typed into the paragraph the first one made.
    expect(r.payload.blocksTouched).toBe(1);
    expect(r.payload.durationMs).toBe(
      Date.parse(r.payload.endTs!) - Date.parse(r.payload.startTs!),
    );
    expect(r.ts).toBe(r.payload.endTs!);
    // Never the edited text, anywhere in the log.
    const log = readFileSync(activityLogPath(dataDir), 'utf8');
    expect(log).not.toContain('Harborlight');
    expect(log).not.toContain('Riverbend');
  }, 30_000);

  it('keeps an agent edit on the same doc out of the human session, and off every stream', async () => {
    await boot(true);
    const docStream = listen(
      await fetch(`${base}/workspaces/${WS}/docs/tides/events:stream`, {
        headers: { host: `localhost:${handle.port}` },
      }),
    );
    await humanTypes();
    const far = await fetch(`${base}/workspaces/${WS}/docs/tides/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'Intro paragraph.', replace: 'Intro paragraph, edited.' }),
    });
    expect(far.ok).toBe(true);

    const rows = await waitFor(() => {
      const r = editRows(dataDir);
      return r.length >= 2 ? r : null;
    });
    expect(rows).toHaveLength(2);
    const human = rows.find((r) => r.payload.source === 'editor');
    const agent = rows.find((r) => r.payload.source === 'mcp');
    expect(human?.actor).toBe('person');
    expect(human?.actorId).toMatch(/^user-/);
    // Only the two browser transactions — the agent's edit is not in here.
    expect(human?.payload.editCount).toBe(2);
    expect(agent?.actor).toBe('agent');
    expect(agent?.isOwner).toBe(false);
    expect(agent?.actorName).toBeUndefined();
    expect(agent?.device).toBeUndefined();
    expect(agent?.payload.editCount).toBe(1);
    expect(agent?.payload.charsInserted ?? 0).toBeGreaterThan(0);

    // Positive control for the stream: a comment posted after both rows were
    // written arrives on it, so an edit_session frame sent earlier would have.
    const posted = await fetch(`${base}/workspaces/${WS}/docs/tides/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: { id: 'known-bob', name: 'Bob', color: '#aa5500', kind: 'known' },
        text: 'Check the Saltmarsh column',
        anchor: {
          kind: 'element',
          fingerprint: { tag: 'P', stableAttrs: {}, classes: [], text: 'Intro' },
        },
      }),
    });
    expect(posted.ok).toBe(true);
    await waitFor(() => docStream.frames.some((f) => f.event.startsWith('thread')));
    expect(docStream.frames.map((f) => f.event)).not.toContain('edit_session');
    docStream.stop();
  }, 30_000);

  it('names an unproven editor by the owner, not its announced name, when writes need no sign-in', async () => {
    await boot(false);
    await humanTypes();
    const [row] = await waitFor(() => {
      const rows = editRows(dataDir);
      return rows.length > 0 ? rows : null;
    });
    expect(row?.actor).toBe('person');
    // A deployment that needs no sign-in is single-person: the server names
    // the editor the owner, whatever its presence announced.
    expect(row?.actorName).toBe(ownerDisplayNames()[0]);
    expect(row?.actorName).not.toBe('Bob');
    expect(row?.actorId).toBeUndefined();
    expect(row?.payload.source).toBe('editor');
  }, 30_000);
});
