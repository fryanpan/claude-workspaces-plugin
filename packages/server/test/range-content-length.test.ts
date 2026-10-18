/**
 * A 206 says how long it is on the wire. Safari (AVFoundation) will not play
 * a video whose range answer arrives `Transfer-Encoding: chunked`, and a
 * phone showed a black player with a spinner because the raw route's 206 did
 * exactly that once the request chain re-wrapped it.
 *
 * Read off a raw socket, not `fetch`: a client's Response hides how the
 * bytes were framed, and the framing is the bug. Each path a response can
 * take out of the server is walked: no Origin (no CORS headers), a trusted
 * Origin (`applyCors` adds its headers), and a session cookie old enough to
 * be re-issued (`refreshSession` appends a Set-Cookie).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE, SESSION_REFRESH_AFTER_MS } from '../src/auth/session.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { voiceAudioDir, voiceSegmentPath } from '../src/voice-feedback-store.ts';
import { tinyMp4 } from './tiny-mp4.ts';
import { seedBoard } from './workspace-seed.ts';

process.env.CW_LOG_LOGIN_CODES = '1';

interface Wire {
  status: number;
  headers: Map<string, string[]>;
  body: Buffer;
}

/**
 * One HTTP/1.1 exchange over a socket, split into status, headers and body as
 * sent. Done once the headers say chunked, or once Content-Length bytes have
 * arrived — not on close, because a keep-alive server need not close.
 */
function onTheWire(port: number, path: string, headers: Record<string, string>): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    const finish = (w: Wire) => {
      sock.destroy();
      resolve(w);
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const split = buf.indexOf('\r\n\r\n');
      if (split < 0) return;
      const lines = buf.subarray(0, split).toString('latin1').split('\r\n');
      const status = Number(lines[0]?.split(' ')[1]);
      const map = new Map<string, string[]>();
      for (const line of lines.slice(1)) {
        const at = line.indexOf(':');
        const k = line.slice(0, at).trim().toLowerCase();
        map.set(k, [...(map.get(k) ?? []), line.slice(at + 1).trim()]);
      }
      const body = buf.subarray(split + 4);
      // Chunked is the failure, and on Bun 1.3.10 the raw route's chunked
      // 206 never sends its last chunk either, so answer from the headers.
      if (map.get('transfer-encoding')?.includes('chunked'))
        return finish({ status, headers: map, body });
      const length = Number(map.get('content-length')?.[0] ?? 0);
      if (body.length >= length) finish({ status, headers: map, body });
    });
    sock.on('error', reject);
    const extra = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');
    sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extra}\r\n`);
  });
}

/** What the re-issued session cookie said on origin/main before this fix. */
const REFRESHED_COOKIE_ATTRS = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=34560000'];

const one = (w: Wire, k: string) => w.headers.get(k)?.join(', ') ?? null;

/** The framing a player needs: an exact length, and no chunking. */
function expectSized(w: Wire, bytes: Uint8Array<ArrayBuffer>) {
  expect(one(w, 'transfer-encoding')).toBeNull();
  expect(one(w, 'content-length')).toBe(String(bytes.length));
  expect(new Uint8Array(w.body)).toEqual(bytes);
}

describe('the framing check itself', () => {
  it('sees chunked encoding when a response is sent chunked (positive control)', async () => {
    let pulls = 0;
    const s = Bun.serve({
      port: 0,
      fetch: () =>
        // Pulled across a macrotask: a stream whose end Bun can reach in
        // the same tick is sent sized, and would prove nothing.
        new Response(
          new ReadableStream({
            async pull(c) {
              await new Promise((r) => setImmediate(r));
              if (pulls++ < 2) c.enqueue(new Uint8Array([1, 2]));
              else c.close();
            },
          }),
        ),
    });
    try {
      const w = await onTheWire(s.port as number, '/', {});
      expect(one(w, 'transfer-encoding')).toBe('chunked');
      expect(one(w, 'content-length')).toBeNull();
    } finally {
      s.stop(true);
    }
  });
});

describe('a range answer keeps its Content-Length through the request chain', () => {
  let handle: ServerHandle;
  let root: string;
  let base: string;
  let ws = '';
  let setId = '';
  let voicePath = '';
  // Big enough that a body which lost its end would be visibly longer than
  // the range, and a chunked body would need more than one chunk.
  const video = tinyMp4(6_204_909, 5);
  const logged: string[] = [];
  const originalLog = console.log;

  beforeAll(async () => {
    console.log = (...args: unknown[]) => {
      const m = args
        .map(String)
        .join(' ')
        .match(/login code for (\S+): (\d{6})/);
      if (m?.[2]) logged.push(m[2]);
      originalLog(...(args as []));
    };
    root = mkdtempSync(join(tmpdir(), 'range-length-'));
    const folder = join(root, 'riverbend');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'notes.md'), '# Riverbend\n');
    writeFileSync(join(folder, 'walkthrough.mp4'), video);
    handle = createServer({ port: 0, dataDir: join(root, 'data'), emailCodeSignIn: true });
    base = `http://127.0.0.1:${handle.port}`;
    ws = await seedBoard(base);
    const bind = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath: folder, hubWorkspaceId: ws }),
    });
    expect(bind.status).toBe(200);
    setId = ((await bind.json()) as { setId: string }).setId;
    voicePath = await seedVoiceNote();
  });

  afterAll(async () => {
    console.log = originalLog;
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const rawPath = () =>
    `/workspaces/${ws}/attachments/${encodeURIComponent(setId)}/raw?path=walkthrough.mp4`;

  /** Sign in over the real routes and return the session cookie pair. */
  async function signIn(): Promise<string> {
    const email = 'riverbend@example.com';
    const start = await fetch(`${base}/api/auth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    expect(start.status).toBe(200);
    const verify = await fetch(`${base}/api/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: logged[logged.length - 1] }),
    });
    expect(verify.status).toBe(200);
    const pair = (verify.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    return pair;
  }

  /** Run `fn` with the server's clock past the session's refresh point. */
  async function laterBy<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    const realNow = Date.now;
    Date.now = () => realNow() + ms;
    try {
      return await fn();
    } finally {
      Date.now = realNow;
    }
  }

  it('without an Origin', async () => {
    const w = await onTheWire(handle.port, rawPath(), { range: 'bytes=0-1' });
    expect(w.status).toBe(206);
    expect(one(w, 'content-range')).toBe(`bytes 0-1/${video.length}`);
    expect(one(w, 'access-control-allow-origin')).toBeNull();
    expectSized(w, video.slice(0, 2));
  });

  it('a range from the middle, without an Origin', async () => {
    const w = await onTheWire(handle.port, rawPath(), { range: 'bytes=1000-1999' });
    expect(w.status).toBe(206);
    expectSized(w, video.slice(1000, 2000));
  });

  it('with a trusted Origin, and the CORS headers are exactly what they were', async () => {
    const origin = 'http://localhost:5173';
    const w = await onTheWire(handle.port, rawPath(), { range: 'bytes=100-199', origin });
    expect(w.status).toBe(206);
    expect(one(w, 'access-control-allow-origin')).toBe(origin);
    expect(one(w, 'access-control-allow-methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
    expect(one(w, 'access-control-allow-headers')).toBe('content-type, authorization');
    expect(one(w, 'access-control-max-age')).toBe('600');
    expect(one(w, 'vary')).toBe('Origin');
    expect(one(w, 'access-control-allow-private-network')).toBeNull();
    expectSized(w, video.slice(100, 200));
  });

  it('with a foreign Origin, which gets Vary and nothing else', async () => {
    const w = await onTheWire(handle.port, rawPath(), {
      range: 'bytes=0-1',
      origin: 'https://saltmarsh.example',
    });
    expect(w.status).toBe(206);
    expect(one(w, 'vary')).toBe('Origin');
    expect(one(w, 'access-control-allow-origin')).toBeNull();
    expectSized(w, video.slice(0, 2));
  });

  it('through a session refresh, which still re-issues the cookie', async () => {
    const cookie = await signIn();
    // Control: a fresh session is not re-issued.
    const fresh = await onTheWire(handle.port, rawPath(), { range: 'bytes=0-1', cookie });
    expect(fresh.headers.get('set-cookie')).toBeUndefined();
    const w = await laterBy(SESSION_REFRESH_AFTER_MS + 60_000, () =>
      onTheWire(handle.port, rawPath(), {
        range: 'bytes=0-1',
        cookie,
        origin: 'http://localhost:5173',
      }),
    );
    expect(w.status).toBe(206);
    const set = w.headers.get('set-cookie') ?? [];
    expect(set).toHaveLength(1);
    const [pair = '', ...attrs] = (set[0] ?? '').split(';').map((p) => p.trim());
    expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(pair).not.toBe(cookie);
    expect(attrs).toEqual(REFRESHED_COOKIE_ATTRS);
    expect(one(w, 'access-control-allow-origin')).toBe('http://localhost:5173');
    expectSized(w, video.slice(0, 2));
  });

  it('a 200 keeps its length too', async () => {
    const w = await onTheWire(handle.port, rawPath(), { origin: 'http://localhost:5173' });
    expect(w.status).toBe(200);
    expectSized(w, video);
  });

  it("a voice note's 206 is sized the same way", async () => {
    const audio = new Uint8Array(await Bun.file(voicePathOnDisk).arrayBuffer());
    const w = await onTheWire(handle.port, voicePath, {
      range: 'bytes=10-19',
      origin: 'http://localhost:5173',
    });
    expect(w.status).toBe(206);
    expect(one(w, 'content-range')).toBe(`bytes 10-19/${audio.length}`);
    expectSized(w, audio.slice(10, 20));
  });

  let voicePathOnDisk = '';
  /** A doc with one recording beside it, written where the route reads it. */
  async function seedVoiceNote(): Promise<string> {
    const md = join(root, 'saltmarsh.md');
    writeFileSync(md, '# Saltmarsh\n');
    const res = await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'saltmarsh', type: 'markdown', sourceUrl: md }),
    });
    expect(res.status).toBe(200);
    const docId = ((await res.json()) as { docId: string }).docId;
    const dataDir = join(root, 'data');
    mkdirSync(voiceAudioDir(dataDir, docId), { recursive: true });
    voicePathOnDisk = voiceSegmentPath(dataDir, docId, 'seg-1.wav') as string;
    writeFileSync(voicePathOnDisk, tinyMp4(50_000, 2));
    return `/workspaces/${ws}/docs/${docId}/voice-feedback/seg-1.wav`;
  }
});
