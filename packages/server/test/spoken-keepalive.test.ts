/**
 * The converse socket's heartbeat through the REAL server. Cloudflare cuts a
 * proxied websocket that carries nothing for 100s, and the lead chat's voice
 * socket was closing with 1006 at about 98s while the lead worked on an
 * answer. The server now sends a `keepalive` frame on every converse socket
 * at a fixed interval; here the interval is shortened through
 * `spokenKeepaliveMs` so a quiet socket shows several of them.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

describe('the converse socket heartbeat', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let boardId = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-spoken-keepalive-'));
    handle = createServer({ port: 0, dataDir, spokenKeepaliveMs: 40 });
    const res = await fetch(`http://127.0.0.1:${handle.port}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harborlight' }),
    });
    boardId = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('sends keepalive frames on a socket nobody speaks on, and a page drops them', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/workspaces/${boardId}/voice/converse`);
    const frames: string[] = [];
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') frames.push(ev.data);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('converse socket refused')));
    });
    // Nothing is sent from this side: the socket is as quiet as a page
    // waiting on the lead.
    const beats = () => frames.filter((f) => JSON.parse(f).type === 'keepalive');
    await waitFor(() => beats().length >= 3, { describe: 'three keepalive frames' });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(new Set(beats())).toEqual(new Set(['{"type":"keepalive"}']));
    // The page's parser, which both voice clients read every frame through,
    // returns nothing for it: no case runs and nothing is shown or reported.
    expect(parseSpokenServerMessage(beats()[0] ?? '')).toBeNull();
    ws.close();
  });
});
