/**
 * An attached app whose dev server stops answering: what the reader gets, and
 * who is told.
 *
 * Driven through the real route table with an upstream that refuses
 * connections — a port that had a dev server on it and now has nothing. The
 * reader's status is 503 because Cloudflare swaps an origin 502 for its own
 * "Bad gateway" page (routes/apps.ts, `APP_DOWN_STATUS`). The agent that
 * attached the app is told once per outage, on its own board stream, and
 * told again only after the app has answered in between.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { startDevServer } from './app-dev-server-fixture.ts';
import { waitFor } from './wait-for.ts';

const ATTACHER = 'agent-harborlight';
const EVENT = 'workspace.app_unreachable';

type Frame = { event: string; data?: Record<string, unknown> };

/** Read an agent's board stream into a growing list of frames. */
async function listen(url: string): Promise<{ frames: Frame[]; stop: () => void }> {
  const abort = new AbortController();
  const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: abort.signal });
  expect(res.status).toBe(200);
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        for (let sep = buf.indexOf('\n\n'); sep >= 0; sep = buf.indexOf('\n\n')) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const frame: Frame = { event: 'message' };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              try {
                frame.data = JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>;
              } catch {}
            }
          }
          frames.push(frame);
        }
      }
    } catch {}
  })();
  return { frames, stop: () => abort.abort() };
}

describe('an attached app whose dev server is down', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws = '';
  let prefix = '';
  let port = 0;
  let stream: { frames: Frame[]; stop: () => void };

  const LOCAL = () => ({ host: `localhost:${handle.port}` });
  const send = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...LOCAL() },
      body: JSON.stringify(body),
    });
  /** A reader opening the app's address, as a browser navigation. */
  const open = () =>
    fetch(`${base}${prefix}`, { headers: { ...LOCAL(), 'sec-fetch-dest': 'document' } });
  const notices = () => stream.frames.filter((f) => f.event === EVENT);

  /** The dev server coming back on the port the app is attached to. */
  const upAgain = () =>
    Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response('<h1>Harborlight</h1>', { headers: { 'content-type': 'text/html' } }),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'app-down-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
    const created = await send('/workspaces', {
      name: 'Harborlight events',
      author: { id: ATTACHER, name: 'Harborlight site', kind: 'agent' },
    });
    ws = ((await created.json()) as { workspace: { id: string } }).workspace.id;
    // A port that had a dev server on it and now refuses connections.
    const gone = startDevServer();
    port = gone.port;
    await gone.stop();
    const attached = await send(`/workspaces/${ws}/apps`, {
      docId: 'harborlight-site',
      origin: gone.origin,
      title: 'Harborlight site',
      producedBy: { agentId: ATTACHER },
    });
    expect(attached.status).toBe(200);
    prefix = ((await attached.json()) as { prefix: string }).prefix;
    stream = await listen(
      `${base}/workspaces/${ws}/events:stream?agentId=${encodeURIComponent(ATTACHER)}`,
    );
  });
  afterAll(async () => {
    stream.stop();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers the reader 503 with the not-running page, uncached', async () => {
    const r = await open();
    expect(r.status).toBe(503);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).toContain('The app is not running');
  });

  it('tells the attaching agent once however many requests fail', async () => {
    for (const path of ['', 'site.css', '__reload', '?cw-frame=1']) {
      const r = await fetch(`${base}${prefix}${path}`, { headers: LOCAL() });
      expect(r.status).toBe(503);
      await r.body?.cancel();
    }
    await waitFor(() => notices().length >= 1, { describe: 'the first outage notice' });
    await (await open()).body?.cancel();
    // A second app going down, AFTER those failures, is a later frame on the
    // same stream: it proves the stream is still delivering, so the count
    // below is not a stream that went quiet.
    const other = await send(`/workspaces/${ws}/apps`, {
      docId: 'riverbend-site',
      origin: `http://127.0.0.1:${port}`,
      producedBy: { agentId: ATTACHER },
    });
    const otherPrefix = ((await other.json()) as { prefix: string }).prefix;
    await (await fetch(`${base}${otherPrefix}`, { headers: LOCAL() })).body?.cancel();
    await waitFor(() => notices().some((f) => f.data?.prefix === otherPrefix), {
      describe: 'the second app’s notice on the same stream',
    });
    const mine = notices().filter((f) => f.data?.prefix === prefix);
    expect(mine).toHaveLength(1);
    const data = mine[0]?.data ?? {};
    expect(data.docId).toBe(prefix.split('/')[4]);
    expect(data.origin).toBe(`http://127.0.0.1:${port}`);
    expect(data.prefix).toBe(prefix);
    expect(data.addressedAs).toBe('attacher');
    expect(data.title).toBe('Harborlight site');
  });

  it('tells the agent again after the app answers and then fails anew', async () => {
    const dev = upAgain();
    const ok = await open();
    expect(ok.status).toBe(200);
    await ok.body?.cancel();
    await dev.stop(true);
    const r = await open();
    expect(r.status).toBe(503);
    await r.body?.cancel();
    await waitFor(() => notices().filter((f) => f.data?.prefix === prefix).length === 2, {
      describe: 'the second outage notice',
    });
  });
});
