/**
 * The spoken reply through the REAL server: the converse socket's guards, a
 * whole question answered and said over it with fake engines, the goal
 * question answered from the board's own goals, and the timings route.
 *
 * The engines are fakes injected through `spokenReply`, so nothing here
 * reaches a vendor. Fixture names are the house ones.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShareTarget } from '../src/middleware/host-guard.ts';
import { createUpgradeStream } from '../src/routes/upgrade-stream.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

const PERSON = { id: 'known-alice', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const UPGRADE = {
  upgrade: 'websocket',
  connection: 'upgrade',
  'sec-websocket-version': '13',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
};

interface Frame {
  type: string;
  [k: string]: unknown;
}

describe('spoken reply over the converse socket', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  let boardId = '';
  const opened: TranscriptionOpenOpts[] = [];
  const said: string[] = [];

  const listener: TranscriptionEngine = {
    name: 'fake',
    async open(opts) {
      opened.push(opts);
      return { send: () => {}, close: async () => {} };
    },
  };
  const voice: SpokenVoice = {
    name: 'fake',
    async speak(text, onAudio) {
      said.push(text);
      onAudio(new Uint8Array(480));
    },
  };

  const post = (path: string, body: unknown, method = 'POST') =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-spoken-'));
    handle = createServer({
      port: 0,
      dataDir,
      spokenReply: { listener, voices: { 1: voice, 2: null }, gemini: null },
    });
    base = `http://127.0.0.1:${handle.port}`;
    wsBase = `ws://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight' });
    boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    const goals = await post(
      `/workspaces/${boardId}/goals`,
      { author: PERSON, goals: [{ title: 'Riverbend import' }, { title: 'Saltmarsh sign in' }] },
      'PUT',
    );
    expect(goals.status).toBe(200);
    const goalId = handle.tasks.getWorkspace(boardId)?.goals[1]?.id ?? '';
    const t = await post(`/workspaces/${boardId}/tasks`, {
      title: 'Bob’s login fix',
      author: PERSON,
    });
    const taskId = ((await t.json()) as { task: { id: string } }).task.id;
    const moved = await post(`/workspaces/${boardId}/tasks/${taskId}/goal`, {
      goal: goalId,
      author: PERSON,
    });
    expect(moved.status, await moved.clone().text()).toBeLessThan(300);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function connect() {
    const ws = new WebSocket(`${wsBase}/workspaces/${boardId}/voice/converse`);
    ws.binaryType = 'arraybuffer';
    const frames: Frame[] = [];
    const audio: number[] = [];
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') frames.push(JSON.parse(ev.data) as Frame);
      else audio.push((ev.data as ArrayBuffer).byteLength);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('converse socket refused')));
    });
    await waitFor(() => frames.some((f) => f.type === 'ready'), { describe: 'ready' });
    return { ws, frames, audio };
  }

  it('offers the setups it has engines for', async () => {
    const { ws, frames } = await connect();
    expect(frames[0]).toEqual({ type: 'ready', setups: [1], timings: {} });
    ws.close();
  });

  it('answers a status ask from the board and says the first two sentences', async () => {
    const { ws, frames, audio } = await connect();
    ws.send(JSON.stringify({ type: 'start', setup: 1, mode: 'hold', author: PERSON }));
    await waitFor(() => opened.length > 0, { describe: 'listener opened' });
    opened.at(-1)?.onTurn({ turn: 0, text: 'Claude, give me a status update.', final: true });
    ws.send(JSON.stringify({ type: 'end' }));
    await waitFor(() => frames.some((f) => f.type === 'audio-end'), { describe: 'audio-end' });
    const reply = frames.find((f) => f.type === 'reply');
    expect(reply?.route).toBe('fast-path');
    expect(reply?.asking).toBe(false);
    expect(String(reply?.spoken)).toStartWith('Harborlight: 1 open');
    // Said point by point: the two sentences are two calls to the voice.
    expect(said.slice(-2).join(' ')).toBe(String(reply?.spoken));
    expect(audio).toEqual([480, 480]);
    ws.close();
  });

  it('asks which goal, then answers for the one picked', async () => {
    const { ws, frames } = await connect();
    const ask = async (text: string, n: number) => {
      ws.send(JSON.stringify({ type: 'start', setup: 1, mode: 'hold', author: PERSON }));
      await waitFor(() => opened.length >= n, { describe: 'listener opened' });
      opened.at(-1)?.onTurn({ turn: 0, text, final: true });
      ws.send(JSON.stringify({ type: 'end' }));
      await waitFor(() => frames.filter((f) => f.type === 'reply').length >= n - base0);
      return frames.filter((f) => f.type === 'reply').at(-1);
    };
    const base0 = opened.length;
    const q = await ask('Claude, how is the goal going?', base0 + 1);
    expect(q?.spoken).toBe('Which goal: Riverbend import or Saltmarsh sign in?');
    expect(q?.asking).toBe(true);
    const a = await ask('the second one', base0 + 2);
    expect(String(a?.spoken)).toStartWith('“Saltmarsh sign in”: 1 open');
    ws.close();
  });

  it('logs a timing and serves the per-setup summary', async () => {
    const { ws, frames } = await connect();
    ws.send(JSON.stringify({ type: 'timing', delayMs: 900 }));
    await waitFor(() => frames.some((f) => f.type === 'timings'), { describe: 'timings' });
    ws.close();
    const r = await fetch(`${base}/workspaces/${boardId}/voice/timings`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { setups: number[]; timings: Record<string, { n: number }> };
    expect(body.setups).toEqual([1]);
    expect(body.timings['1']?.n).toBe(1);
    expect((await fetch(`${base}/workspaces/w-nope/voice/timings`)).status).toBe(404);
  });

  it('refuses a foreign origin and an unknown board', async () => {
    const foreign = await fetch(`${base}/workspaces/${boardId}/voice/converse`, {
      headers: { ...UPGRADE, origin: 'https://elsewhere.example.com' },
    });
    expect(foreign.status).toBe(403);
    const missing = await fetch(`${base}/workspaces/w-nope/voice/converse`, { headers: UPGRADE });
    expect(missing.status).toBe(404);
  });

  it('refuses a share visitor before anything else', () => {
    // Driven through the route itself with a visitor, as meeting-cost.test.ts
    // does: a whole share-link flow would be testing the share instead.
    const stream = createUpgradeStream({
      j: (status: number, body: unknown) => Response.json(body, { status }),
    } as never);
    const url = new URL(`http://localhost/workspaces/${boardId}/voice/converse`);
    const out = stream.serveUpgradeAndStreamRoutes({
      req: new Request(url, { headers: UPGRADE }),
      url,
      pathname: url.pathname,
      visitor: { workspaceId: boardId } as ShareTarget,
      visitorShareId: 's1',
      visitorMemberKey: null,
      ownerProven: () => false,
      anyoneProven: () => false,
      browserProvedNobody: () => true,
      provenAuthor: () => null,
      widgetDoorGrant: null,
    });
    expect(out?.kind).toBe('response');
    expect(out && out.kind === 'response' ? out.response.status : 0).toBe(403);
  });
});
