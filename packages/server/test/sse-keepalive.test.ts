/**
 * An SSE stream has to outlive the idle timeout that is watching it.
 *
 * Measured 2026-08-19 against this server on Bun 1.3.10: a plain
 * `curl -N` on `/workspaces/<id>/events:stream` ended after **9.7 seconds** having
 * received five bytes — the `:ok` preamble and nothing else. It was asked to
 * hold for forty.
 *
 * The cause was arithmetic, not logic. The keepalive comment existed and fired
 * on a 20s period; `Bun.serve` was configured with no `idleTimeout` at all, and
 * Bun's default is 10 seconds. The guard's period was longer than the timeout
 * it was guarding, so the connection always idled out first and the keepalive
 * never got to write anything.
 *
 * Why it stayed hidden, and why these tests are shaped the way they are:
 * `EventSource` reconnects silently, so six lossy windows a minute on every
 * open tab looked exactly like a healthy page. There is no `Last-Event-ID`
 * replay, so everything broadcast during those gaps was lost for good. A
 * regression here is invisible by construction — which is why the invariant is
 * asserted directly rather than only through behaviour.
 *
 * WHY THIS FILE IS NO LONGER NINETEEN SECONDS LONG. It used to hold one stream
 * open for a real `SSE_KEEPALIVE_MS` (15s) and watch a second die on a doomed
 * server built here (4s), which made it the single most expensive file in the
 * server suite — 19.3s of the 308s the whole suite spends. The claim is split
 * into the three things the bug was actually made of, each with an observable
 * that arrives in its own time rather than the product's:
 *
 *   1. the two numbers still mean something together (arithmetic, free);
 *   2. the interval really WRITES to a live stream (`openSseStream` on a
 *      100ms period — the seam `sse-mux.ts` already had);
 *   3. the timeout this server configures really reaches `Bun.serve`, watched
 *      on a server whose idle timeout is one second while the shipped
 *      keepalive (15s) is far too slow to save it. That is the shipped bug in
 *      miniature, and a build that dropped `idleTimeout` from `Bun.serve`
 *      falls back to Bun's ~10s default and fails it.
 *
 * 2 and 3 are each other's control: one is a stream that must stay open, the
 * other a stream that must close, read by the same watcher.
 *
 * WHAT NO LONGER HAS A BEHAVIOURAL PROOF, said plainly: that the period a
 * PRODUCTION stream runs on is `SSE_KEEPALIVE_MS` rather than some other
 * number. Watching that costs one real period. It is a default parameter on
 * `openSseStream` with no production caller overriding it, and case 1 is what
 * keeps the number itself honest.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { HTTP_IDLE_TIMEOUT_SEC, SSE_KEEPALIVE_MS, SseBus, openSseStream } from '../src/sse.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

describe('the keepalive/idle-timeout invariant', () => {
  it('fires the keepalive well inside the idle timeout it guards', () => {
    // THE test. The shipped bug was 20_000 against a 10_000 default, and this
    // single comparison is the whole of it.
    expect(SSE_KEEPALIVE_MS).toBeLessThan(HTTP_IDLE_TIMEOUT_SEC * 1000);
    // With margin, so that ONE dropped or delayed keepalive is survivable
    // rather than fatal. A guard that only just fits is a guard that fails the
    // first time the event loop is busy.
    expect(SSE_KEEPALIVE_MS * 2).toBeLessThanOrEqual(HTTP_IDLE_TIMEOUT_SEC * 1000);
  });

  it('keeps the idle timeout inside the range Bun will accept', () => {
    // Bun caps `idleTimeout` at 255s and throws on a larger value — at boot,
    // which means a bad number here takes the whole server down rather than
    // degrading. Cheaper to fail in CI.
    expect(HTTP_IDLE_TIMEOUT_SEC).toBeGreaterThan(0);
    expect(HTTP_IDLE_TIMEOUT_SEC).toBeLessThanOrEqual(255);
  });
});

/** Reads a stream in the background and records whether the server ended it. */
function watch(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const state = { closed: false, bytes: 0 };
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          state.closed = true;
          return;
        }
        state.bytes += value?.byteLength ?? 0;
      }
    } catch {
      // A torn-down stream is a close as far as the reader is concerned.
      state.closed = true;
    }
  })();
  return { state, pump, cancel: () => void reader.cancel().catch(() => {}) };
}

describe('the keepalive writes, so an idle stream is not a silent one', () => {
  it('keeps enqueueing on its own period with nothing else to send', async () => {
    const bus = new SseBus();
    // 100ms rather than 15s: the claim is that the interval fires and writes,
    // and that claim does not get truer for being waited out longer.
    const w = watch(
      openSseStream(bus, 'doc-ka', undefined, undefined, undefined, undefined, undefined, 100),
    );
    // The `:ok` preamble is five bytes, written once at start. Anything past
    // it on a channel nobody broadcasts to is the keepalive and nothing else.
    const preamble = await waitFor(() => (w.state.bytes > 0 ? w.state.bytes : false), {
      describe: 'the stream preamble',
    });
    await waitFor(() => w.state.bytes > preamble, {
      describe: 'a keepalive comment past the preamble',
    });
    expect(w.state.closed).toBe(false);
    w.cancel();
  }, 10_000);
});

describe('the idle timeout this server configures is the one Bun enforces', () => {
  let handle: ServerHandle | null = null;
  let dataDir = '';

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * The stream read over a RAW SOCKET rather than `fetch`.
   *
   * Bun's fetch reopens an idempotent GET once when the server drops the
   * connection under it, so the reader saw a second `:ok` preamble at ~4s and
   * only ended at ~8s — one close read as two, and the budget below would have
   * had to be wide enough to swallow both. A socket reports the close the
   * server actually performed, at the moment it performs it.
   */
  function rawStream(port: number, path: string) {
    const state = { bytes: 0, closed: false, status: '' };
    const socket = Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(s) {
          s.write(
            `GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n`,
          );
        },
        data(_s, chunk) {
          const text = new TextDecoder().decode(chunk);
          if (state.status === '') state.status = text.slice(0, text.indexOf('\r\n'));
          state.bytes += chunk.byteLength;
        },
        close() {
          state.closed = true;
        },
        error() {
          state.closed = true;
        },
      },
    });
    return { state, end: async () => (await socket).end() };
  }

  it('closes a stream the keepalive is too slow to save — the shipped bug, in miniature', async () => {
    // One second of idle timeout against the shipped 15s keepalive: the guard's
    // period is longer than the timeout it guards, which is exactly the
    // arithmetic that shipped. Bun rounds its idle check up to about four
    // seconds whatever the configured value, so the close lands there.
    //
    // THIS IS THE WIRING TEST. Drop `idleTimeout` from the `Bun.serve` options
    // and Bun's own ~10s default applies instead: the close never arrives
    // inside the budget below and this goes red. It is also the control for
    // the case above — one stream that must stay open, one that must close.
    dataDir = mkdtempSync(join(tmpdir(), 'sse-idle-'));
    handle = createServer({ port: 0, dataDir, httpIdleTimeoutSec: 1 });
    const base = `http://127.0.0.1:${handle.port}`;
    const host = `localhost:${handle.port}`;
    const ws = await seedBoard(base, { host });
    const stream = rawStream(handle.port, `/workspaces/${ws}/events:stream`);
    // It started: "closed" below is a stream that lived and then died, not a
    // request that never got an answer.
    await waitFor(() => stream.state.status.includes('200'), {
      describe: 'the stream to answer 200',
    });
    expect(stream.state.bytes).toBeGreaterThan(0);
    await waitFor(() => stream.state.closed, {
      timeout: 8_000,
      describe: 'the configured idle timeout to close the stream',
    });
    expect(stream.state.closed).toBe(true);
  }, 20_000);
});
