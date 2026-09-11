/**
 * `GET`/`POST /api/sentry` — a process reports its own Sentry state, counted
 * at the SDK's hooks, and can send itself one event to prove the path.
 *
 * Why this exists: on 2026-09-08 prod's server was initialised, could
 * resolve the SDK, could reach the ingest host, and still showed no span in
 * Sentry — and nothing outside the process could say which stage had lost
 * it. The route answers that from inside.
 *
 * The transport is pointed at a local capture server, so the assertions
 * read what actually arrived on a socket, never the module's own counters
 * alone. The gates are asserted with a positive control beside each
 * negative: the same call from the box succeeds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  flushServerSentry,
  initServerSentry,
  resetServerSentryForTest,
  selfTestServerSentry,
} from '../src/sentry.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

type Hit = { text: string };

function startCaptureServer(): { dsn: string; hits: () => Hit[]; stop: () => void } {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const bytes = new Uint8Array(await req.arrayBuffer());
      const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
      hits.push({ text: new TextDecoder().decode(isGzip ? Bun.gunzipSync(bytes) : bytes) });
      return new Response('{}', { status: 200 });
    },
  });
  return {
    dsn: `http://examplekey@127.0.0.1:${server.port}/1`,
    hits: () => hits,
    stop: () => server.stop(true),
  };
}

type SentryBody = {
  sentry: {
    active: boolean;
    captured: number;
    sent: number;
    lastSendStatus: number | null;
    lastSendType: string | null;
    flushed?: boolean;
    eventId?: string | null;
  };
};

let h: ServerHandle;
let dataDir: string;

const fromBox = (method: string, extra: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${h.port}/api/sentry`, {
    method,
    headers: { host: `localhost:${h.port}`, ...extra },
  });

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sentry-self-test-'));
  h = createServer({ port: 0, dataDir });
});

afterAll(async () => {
  await h.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('/api/sentry with no DSN configured', () => {
  beforeAll(() => resetServerSentryForTest());

  it('GET reports inactive with zero counts', async () => {
    const r = await fromBox('GET');
    expect(r.status).toBe(200);
    const { sentry } = (await r.json()) as SentryBody;
    expect(sentry.active).toBe(false);
    expect(sentry.captured).toBe(0);
    expect(sentry.sent).toBe(0);
  });

  it('POST sends nothing and says so', async () => {
    const r = await fromBox('POST');
    expect(r.status).toBe(200);
    const { sentry } = (await r.json()) as SentryBody;
    expect(sentry.active).toBe(false);
    expect(sentry.eventId).toBeNull();
    expect(sentry.sent).toBe(0);
  });
});

describe('/api/sentry with a DSN pointed at a capture server', () => {
  let capture: ReturnType<typeof startCaptureServer>;

  beforeAll(async () => {
    capture = startCaptureServer();
    await initServerSentry({ dsn: capture.dsn, release: 'a822618-dirty' });
  });

  afterAll(async () => {
    await flushServerSentry(2000);
    resetServerSentryForTest();
    capture.stop();
  });

  it('POST sends one event, the capture server receives it, and the counts say so', async () => {
    const before = capture.hits().length;
    const r = await fromBox('POST');
    expect(r.status).toBe(200);
    const { sentry } = (await r.json()) as SentryBody;
    expect(sentry.active).toBe(true);
    expect(sentry.flushed).toBe(true);
    expect(typeof sentry.eventId).toBe('string');
    await waitFor(() => capture.hits().length > before, {
      describe: 'self-test envelope to arrive',
    });
    expect(
      capture
        .hits()
        .slice(before)
        .some((x) => x.text.includes('server sentry self-test')),
    ).toBe(true);
    expect(sentry.sent).toBeGreaterThanOrEqual(1);
    expect(sentry.captured).toBeGreaterThanOrEqual(1);
    expect(sentry.lastSendStatus).toBe(200);
    // Every request to this server runs under a route span, so a
    // transaction from an earlier request can be the last envelope
    // answered; what is asserted is that a type was recorded at all.
    expect(sentry.lastSendType === 'error' || sentry.lastSendType === 'transaction').toBe(true);
  });

  it('GET reads the counters without sending a self-test event', async () => {
    const hitsBefore = capture.hits().length;
    const r = await fromBox('GET');
    expect(r.status).toBe(200);
    const { sentry } = (await r.json()) as SentryBody;
    expect(sentry.active).toBe(true);
    expect(sentry.eventId).toBeUndefined();
    await flushServerSentry(1000);
    // The GET's own route span may land as a transaction; no self-test
    // message may.
    const selfTests = capture
      .hits()
      .slice(hitsBefore)
      .filter((x) => x.text.includes('server sentry self-test'));
    expect(selfTests.length).toBe(0);
  });

  it('the module-level self-test reports the transport status it was answered with', async () => {
    const result = await selfTestServerSentry();
    expect(result.active).toBe(true);
    expect(result.lastSendStatus).toBe(200);
  });

  // A bare `cf-ray` on a plain host is refused by the host guard before any
  // route runs; the route's own edge gate is exercised with a full proxied
  // setup in deploy-proxied.test.ts. Here: refused, and no self-test sent.
  it('refuses a request carrying cf-ray, and the same call from the box still works', async () => {
    const hitsBefore = capture.hits().length;
    const refused = await fromBox('POST', { 'cf-ray': '8a1b2c3d4e5f-SJC' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    await flushServerSentry(1000);
    expect(
      capture
        .hits()
        .slice(hitsBefore)
        .some((x) => x.text.includes('server sentry self-test')),
    ).toBe(false);
    const ok = await fromBox('POST');
    expect(ok.status).toBe(200);
  });

  it('refuses a browser (origin header) on GET and POST alike, sending nothing', async () => {
    const hitsBefore = capture.hits().length;
    for (const method of ['GET', 'POST']) {
      const r = await fromBox(method, { origin: `http://127.0.0.1:${h.port}` });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    await flushServerSentry(1000);
    expect(
      capture
        .hits()
        .slice(hitsBefore)
        .some((x) => x.text.includes('server sentry self-test')),
    ).toBe(false);
  });
});
