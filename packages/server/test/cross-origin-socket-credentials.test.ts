/**
 * A socket from a dev server on another port, carrying the reader's real
 * sign-in cookie, gets what a socket with no sign-in gets — through the real
 * server, with a real session.
 *
 * The observable is the widget's own creation path: opening a doc's editing
 * socket with `?type=mockup` for an id nobody made creates that doc, and on a
 * server that asks browsers to sign in only a socket that proved somebody may
 * do it. Before this, the reader's cookie, which the browser attaches to any
 * same-site handshake, was that proof for any page on any local port.
 *
 * Positive controls: the same cookie from this server's own origin creates
 * the doc, and the widget's own credential, a widget token minted for the dev
 * server's origin and offered as the socket's subprotocol, creates it from
 * the dev server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE } from '../src/auth/session.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

// The log sender masks the code unless this is set (`auth/code-sender.ts`).
process.env.CW_LOG_LOGIN_CODES = '1';

const DEV_ORIGIN = 'http://127.0.0.1:5173';

const codes: string[] = [];
const originalLog = console.log;

describe('a cross-origin socket does not sign in with the reader’s cookie', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws = '';
  let cookie = '';
  let token = '';

  const open = (docId: string, origin: string, protocol?: string) =>
    fetch(`${base}/workspaces/${ws}/docs/${docId}/y?type=mockup`, {
      headers: {
        origin,
        cookie,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...(protocol ? { 'sec-websocket-protocol': protocol } : {}),
      },
    });

  beforeAll(async () => {
    console.log = (...args: unknown[]) => {
      const m = args
        .map(String)
        .join(' ')
        .match(/login code for \S+: (\d{6})/);
      if (m?.[1]) codes.push(m[1]);
      originalLog(...(args as []));
    };
    dataDir = mkdtempSync(join(tmpdir(), 'cross-origin-socket-'));
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
  });

  afterAll(async () => {
    console.log = originalLog;
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses to create a doc for a dev server page that brings only the cookie', async () => {
    const r = await open('riverbend-cookie', DEV_ORIGIN);
    expect(r.status).toBe(401);
    expect(handle.docStore.get('riverbend-cookie')).toBeUndefined();
  });

  it('creates it for this server’s own page with the same cookie — POSITIVE CONTROL', async () => {
    const r = await open('riverbend-own', `http://127.0.0.1:${handle.port}`);
    expect(r.status).toBe(101);
    expect(handle.docStore.get('riverbend-own')?.meta.type).toBe('mockup');
  });

  it('creates it for the widget on the dev server, whose token is its credential', async () => {
    const r = await open('riverbend-widget', DEV_ORIGIN, token);
    expect(r.status).toBe(101);
    expect(handle.docStore.get('riverbend-widget')?.meta.type).toBe('mockup');
  });
});
