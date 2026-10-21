/**
 * The app voice socket through the REAL server: a served app frame carries a
 * token, speaks a line, hears a scripted reply with its turn end, and makes a
 * `say` write that reaches the app's dev server. Then every refusal the
 * upgrade makes on its own, through the same server.
 *
 * The engines are scripted and injected through `spokenReply`, so nothing
 * here reaches a vendor. Fixture names are the house ones.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_VOICE_SEED_ATTR,
  type AppVoiceSeed,
  parseAppVoiceSeed,
} from '@claude-workspaces/core/app-voice';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

setDefaultTimeout(30_000);

const AGENT = { id: 'agent-harborlight', name: 'Harborlight Agent', kind: 'agent' };
const FRAME_ORIGIN = 'https://frames.harborlight.test';
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

/** The app's dev server: one page that loads the client, and `/say`. */
function startApp() {
  const said: { body: string; type: string | null }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/say' && req.method === 'POST') {
        said.push({ body: await req.text(), type: req.headers.get('content-type') });
        return new Response(null, { status: 204 });
      }
      return new Response(
        '<!doctype html><html><head><title>Riverbend deliberation</title>' +
          '<script src="/widget/app-voice.js"></script></head><body><h1>Riverbend</h1></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, said, stop: () => server.stop(true) };
}

describe('the app voice socket', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  let app: ReturnType<typeof startApp>;
  let board = '';
  let docId = '';
  let otherDoc = '';
  const spoken: { text: string }[] = [];
  const listeners: TranscriptionOpenOpts[] = [];

  // Speaks 960 bytes per line, in two chunks.
  const voice: SpokenVoice = {
    name: 'scripted',
    async speak(text, onAudio) {
      spoken.push({ text });
      onAudio(new Uint8Array(480));
      onAudio(new Uint8Array(480));
    },
  };
  // Hears "I think so" from the first two frames of audio it is sent: a
  // provisional turn, then the final one its end of speech settles.
  const listener: TranscriptionEngine = {
    name: 'scripted',
    async open(opts) {
      listeners.push(opts);
      let frames = 0;
      return {
        send: () => {
          frames++;
          if (frames === 1) opts.onTurn({ turn: 0, text: 'I think', final: false });
          if (frames === 2) opts.onTurn({ turn: 0, text: 'I think so.', final: true });
        },
        close: async () => {},
      };
    },
  };

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-app-voice-'));
    app = startApp();
    handle = createServer({
      port: 0,
      dataDir,
      frameOrigin: FRAME_ORIGIN,
      spokenReply: { listener, voices: { 1: voice, 2: null }, gemini: null },
    });
    base = `http://127.0.0.1:${handle.port}`;
    wsBase = `ws://127.0.0.1:${handle.port}`;
    const ws = await post('/workspaces', { name: 'Harborlight', author: AGENT });
    board = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    for (const name of ['riverbend-pilot', 'saltmarsh-pilot']) {
      const r = await post(`/workspaces/${board}/apps`, { docId: name, origin: app.origin });
      expect(r.status, await r.clone().text()).toBe(200);
      const id = ((await r.json()) as { docId: string }).docId;
      if (name === 'riverbend-pilot') docId = id;
      else otherDoc = id;
    }
  });

  afterAll(async () => {
    await handle.stop();
    app.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** The seed the server wrote into the app's frame. */
  async function frameSeed(id = docId): Promise<AppVoiceSeed> {
    const r = await fetch(`${base}/workspaces/${board}/apps/${id}/?cw-frame=1`);
    expect(r.status).toBe(200);
    const html = await r.text();
    const m = new RegExp(
      `<script type="application/json" ${APP_VOICE_SEED_ATTR}>([^<]*)</script>`,
    ).exec(html);
    const seed = parseAppVoiceSeed(m?.[1]);
    if (!seed) throw new Error('no app voice seed in the frame');
    return seed;
  }

  async function connect(seed: AppVoiceSeed, origin: string) {
    const url = `${wsBase}${seed.socket}?token=${encodeURIComponent(seed.token)}`;
    // Bun's client takes headers, so the socket can say which page it is.
    const ws = new WebSocket(url, { headers: { origin } } as unknown as string[]);
    ws.binaryType = 'arraybuffer';
    const frames: Frame[] = [];
    const audio: number[] = [];
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') frames.push(JSON.parse(ev.data) as Frame);
      else audio.push((ev.data as ArrayBuffer).byteLength);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('app voice socket refused')));
    });
    await waitFor(() => frames.some((f) => f.type === 'ready'), { describe: 'ready' });
    return { ws, frames, audio };
  }

  /** The socket's answer to an upgrade, as a status. */
  const upgradeStatus = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers: { ...UPGRADE, ...headers } }).then((r) => r.status);

  it("writes the socket's path and a token for this doc into the app's frame", async () => {
    const seed = await frameSeed();
    expect(seed.socket).toBe(`/workspaces/${board}/docs/${docId}/app-voice`);
    // The host page a person opens carries none: it is the frame's script
    // that talks.
    const host = await fetch(`${base}/workspaces/${board}/apps/${docId}/`).then((r) => r.text());
    expect(host).not.toContain(APP_VOICE_SEED_ATTR);
  });

  it('speaks a line, hears a reply with its turn end, and writes to the app', async () => {
    const { ws, frames, audio } = await connect(await frameSeed(), 'null');
    expect(frames[0]).toEqual({
      type: 'ready',
      voice: 'scripted',
      listen: true,
      say: true,
      outputRate: 24_000,
      inputRate: 16_000,
    });

    ws.send(
      JSON.stringify({ type: 'speak', text: 'Welcome to Riverbend.', tone: 'warm', id: 'l1' }),
    );
    await waitFor(() => frames.some((f) => f.type === 'spoken'), { describe: 'spoken' });
    expect(spoken.at(-1)).toEqual({ text: 'Welcome to Riverbend.' });
    expect(audio).toEqual([480, 480]);
    expect(frames.filter((f) => f.type === 'speaking' || f.type === 'spoken')).toEqual([
      { type: 'speaking', id: 'l1' },
      { type: 'spoken', id: 'l1', stopped: false },
    ]);

    ws.send(JSON.stringify({ type: 'listen' }));
    await waitFor(() => frames.some((f) => f.type === 'listening'), { describe: 'listening' });
    ws.send(new Uint8Array(1600));
    ws.send(new Uint8Array(1600));
    await waitFor(() => frames.some((f) => f.type === 'turn-end'), { describe: 'turn-end' });
    expect(listeners.at(-1)?.sampleRate).toBe(16_000);
    expect(frames.filter((f) => f.type === 'heard' || f.type === 'turn-end')).toEqual([
      { type: 'heard', text: 'I think' },
      { type: 'heard', text: 'I think so.' },
      { type: 'turn-end', text: 'I think so.' },
    ]);

    ws.send(JSON.stringify({ type: 'say', text: 'Saltmarsh first', id: 'w1' }));
    await waitFor(() => frames.some((f) => f.type === 'said'), { describe: 'said' });
    expect(frames.find((f) => f.type === 'said')).toEqual({ type: 'said', id: 'w1', status: 204 });
    expect(app.said).toEqual([
      { body: JSON.stringify({ text: 'Saltmarsh first' }), type: 'application/json' },
    ]);
    ws.close();
  });

  it('listens from a page in its own tab and from a frame with an origin of its own', async () => {
    for (const origin of [base, FRAME_ORIGIN]) {
      const { ws, frames } = await connect(await frameSeed(), origin);
      ws.send(JSON.stringify({ type: 'listen' }));
      await waitFor(() => frames.some((f) => f.type === 'listening'), { describe: 'listening' });
      ws.send(new Uint8Array(1600));
      ws.send(new Uint8Array(1600));
      await waitFor(() => frames.some((f) => f.type === 'turn-end'), {
        describe: `turn-end from ${origin}`,
      });
      ws.close();
    }
  });

  it('opens on the address the host page relays a sandboxed frame to', async () => {
    // `mock-relay-policy.ts` keeps the frame's token and adds the mark; the
    // host is a page on this server, so the origin is the server's own.
    const seed = await frameSeed();
    const relayed = `${seed.socket}?token=${encodeURIComponent(seed.token)}&cw-via=mock-frame`;
    expect(await upgradeStatus(relayed, { origin: base })).toBe(101);
  });

  describe('refuses', () => {
    const path = () => `/workspaces/${board}/docs/${docId}/app-voice`;

    it('a socket with no token', async () => {
      expect(await upgradeStatus(path(), { origin: 'null' })).toBe(401);
    });

    it('a token for another doc on the same board', async () => {
      const other = await frameSeed(otherDoc);
      expect(
        await upgradeStatus(`${path()}?token=${encodeURIComponent(other.token)}`, {
          origin: 'null',
        }),
      ).toBe(401);
      // The positive control: that token opens its own doc's socket.
      expect(
        await upgradeStatus(`${other.socket}?token=${encodeURIComponent(other.token)}`, {
          origin: 'null',
        }),
      ).toBe(101);
    });

    it('an expired token', async () => {
      const stale = handle.appVoice.mint(board, docId, Date.now() - 11 * 60_000);
      expect(
        await upgradeStatus(`${path()}?token=${encodeURIComponent(stale.token)}`, {
          origin: 'null',
        }),
      ).toBe(401);
      const fresh = handle.appVoice.mint(board, docId);
      expect(
        await upgradeStatus(`${path()}?token=${encodeURIComponent(fresh.token)}`, {
          origin: 'null',
        }),
      ).toBe(101);
    });

    it('a page on another site holding a good token', async () => {
      const seed = await frameSeed();
      expect(
        await upgradeStatus(`${path()}?token=${encodeURIComponent(seed.token)}`, {
          origin: 'https://elsewhere.example.com',
        }),
      ).toBe(403);
    });
  });
});
