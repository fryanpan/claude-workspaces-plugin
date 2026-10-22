/**
 * The widget's doc socket on a localhost dev server, against a real server
 * that requires sign-in, through the widget's own socket client (`connect`
 * from core) offering the token as the widget does, with a real session.
 *
 * The server ignores the reader's cookie on a socket from another origin, so
 * the session token (`wt1`) the widget holds is what lets its first socket
 * create a page's doc. A token the server no longer accepts gets the
 * handshake refused, and the widget must then open without it, read-only,
 * rather than be left with no socket.
 *
 * The page is stood in for by a WebSocket subclass that sends what a browser
 * on the dev server would: its Origin and the reader's cookie.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FeedbackClient, connect } from '@claude-workspaces/core';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

// The log sender masks the code unless this is set (`auth/code-sender.ts`).
process.env.CW_LOG_LOGIN_CODES = '1';

const DEV_ORIGIN = 'http://127.0.0.1:5173';
const NativeWebSocket = globalThis.WebSocket;
const codes: string[] = [];
const originalLog = console.log;

describe('the widget socket offers its session token, and drops a dead one', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws = '';
  let cookie = '';
  let token = '';
  /** The subprotocol each handshake offered, in order. */
  const offered: (string | undefined)[] = [];
  const clients: FeedbackClient[] = [];

  /** Open the widget's socket on `docId` holding `held`, as the widget does. */
  const widgetSocket = (docId: string, held: string): FeedbackClient => {
    const url = `ws://127.0.0.1:${handle.port}/workspaces/${ws}/docs/${docId}/y?type=mockup&sourceUrl=${encodeURIComponent(`${DEV_ORIGIN}/`)}`;
    const client = connect(url, () => held);
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    console.log = (...args: unknown[]) => {
      const m = args
        .map(String)
        .join(' ')
        .match(/login code for \S+: (\d{6})/);
      if (m?.[1]) codes.push(m[1]);
      originalLog(...(args as []));
    };
    dataDir = mkdtempSync(join(tmpdir(), 'widget-socket-token-'));
    handle = createServer({ port: 0, dataDir, emailCodeSignIn: true });
    base = `http://127.0.0.1:${handle.port}`;
    ws = handle.tasks.createWorkspace('Harborlight').id;
    const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...extra },
        body: JSON.stringify(body),
      });
    expect((await post('/api/auth/start', { email: 'alice@example.com' })).status).toBe(200);
    const verified = await post('/api/auth/verify', {
      email: 'alice@example.com',
      code: codes.at(-1),
    });
    expect(verified.status).toBe(200);
    cookie = (verified.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    const minted = await post('/api/auth/widget-token', { origin: DEV_ORIGIN }, { cookie });
    expect(minted.status).toBe(200);
    token = ((await minted.json()) as { token: string }).token;
    expect(token.startsWith('wt1.')).toBe(true);

    class PageSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        const list = protocols === undefined ? [] : [protocols].flat();
        offered.push(list[0]);
        super(url, {
          headers: { origin: DEV_ORIGIN, cookie },
          ...(list.length ? { protocols: list } : {}),
        } as unknown as string[]);
      }
    }
    globalThis.WebSocket = PageSocket as typeof WebSocket;
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    globalThis.WebSocket = NativeWebSocket;
    console.log = originalLog;
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a live session token creates a new page’s doc', async () => {
    const client = widgetSocket('riverbend-page', token);
    await waitFor(() => client.status === 'open', { describe: 'the socket to open' });
    expect(offered.at(-1)).toBe(token);
    expect(handle.docStore.get('riverbend-page')?.meta.type).toBe('mockup');
    client.close();
  });

  it('a dead session token is dropped after one refusal and the socket opens read-only', async () => {
    const from = offered.length;
    const client = widgetSocket('riverbend-page', 'wt1.dead.token.value');
    await waitFor(() => client.status === 'open', {
      describe: 'the socket to open without the dead token',
    });
    expect(offered.slice(from)).toEqual(['wt1.dead.token.value', undefined]);
    const conns = [...(handle.docStore.get('riverbend-page')?.conns ?? [])];
    expect(conns.length).toBe(1);
    expect(conns.every((c) => c.data.readOnly === true)).toBe(true);
    client.close();
  });
});
