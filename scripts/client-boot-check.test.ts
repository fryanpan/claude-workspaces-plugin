/**
 * The pure parts of the bundled-client boot gate.
 *
 * The gate's whole value is in the parts that need a browser, and those are
 * exercised by running it — `bun run check:client-boot` IS its own test, and
 * a mutation control (a throw planted in block-identity.ts, or the namespace
 * read put back) is how it gets proven. What is here is the handful of pure
 * decisions around that, each of which has already been wrong once:
 *
 *   - the port was assumed rather than read, and the check talked to whatever
 *     else was listening;
 *   - the page URL was concatenated from a server-minted ABSOLUTE url, which
 *     produced something Chrome refused — and would have silently checked the
 *     wrong host on a machine whose tailnet name resolved;
 *   - a slow wire was reported as a broken page, so builders learned to wave
 *     the check through (client-boot-transport.ts).
 */
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { exceptionText, listeningPort, parseArgs } from './client-boot-check';
import { controlFetch, slowestTransfer, transportVerdict } from './client-boot-transport';

describe('parseArgs', () => {
  it('lets the OS pick the port, and gives load and mount separate ceilings', () => {
    const o = parseArgs([]);
    // Port 0: a fixed default is a port some other agent on the same machine
    // already holds, and 8800 was one.
    expect(o.port).toBe(0);
    // The load is the wire and the mount is the bundle — one number for both
    // turned a slow machine into a "broken" page.
    expect(o.timeoutMs).toBe(10_000);
    expect(o.loadTimeoutMs).toBe(90_000);
    expect(o.keep).toBe(false);
    expect(o.shot).toBeUndefined();
  });

  it('takes an explicit port, both timeouts, screenshot and --keep', () => {
    const o = parseArgs([
      '--port',
      '8866',
      '--timeout',
      '4000',
      '--load-timeout',
      '20000',
      '--shot',
      '/tmp/x.png',
      '--keep',
    ]);
    expect(o).toMatchObject({
      port: 8866,
      timeoutMs: 4000,
      loadTimeoutMs: 20_000,
      shot: '/tmp/x.png',
      keep: true,
    });
  });

  it('refuses every port another service owns, and names the way out', () => {
    // The four bin.ts refuses, plus the two this check steers clear of.
    for (const port of [8787, 8791, 7900, 7902, 7903, 8800]) {
      expect(() => parseArgs(['--port', String(port)])).toThrow(/reserved.*omit --port/);
    }
    // The control: a port nobody owns is taken as given.
    expect(parseArgs(['--port', '8867']).port).toBe(8867);
  });

  it('refuses a port or timeout that is not an integer in range', () => {
    expect(() => parseArgs(['--port', '-1'])).toThrow(/--port/);
    expect(() => parseArgs(['--timeout', '0'])).toThrow(/--timeout/);
    expect(() => parseArgs(['--timeout', 'soon'])).toThrow(/--timeout/);
    expect(() => parseArgs(['--load-timeout', 'later'])).toThrow(/--load-timeout/);
  });
});

describe('listeningPort', () => {
  it("reads the port out of the server's own announcement", () => {
    // bin.ts walks up to twenty ports when the first is busy, so the port the
    // check asked for is not the port it must talk to.
    expect(listeningPort('[feedback] listening on http://127.0.0.1:8804')).toBe(8804);
    expect(listeningPort('[feedback] listening on :8800')).toBe(8800);
  });

  it('answers null for a line that is not the announcement', () => {
    // The control: every other line the server prints must not be mistaken
    // for a port, or the check attaches to a number out of a log message.
    expect(listeningPort('[meetings] Recall key REJECTED by us-east-1 (401)')).toBeNull();
    expect(listeningPort('')).toBeNull();
  });
});

describe('exceptionText', () => {
  it('prefers the exception description and names where it happened', () => {
    expect(
      exceptionText({
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'ReferenceError: KO8 is not defined' },
          url: 'http://127.0.0.1:8800/app/app.js',
          lineNumber: 3456,
        },
      }),
    ).toBe('ReferenceError: KO8 is not defined (http://127.0.0.1:8800/app/app.js:3456)');
  });

  it('falls back to the bare text, and never reports nothing at all', () => {
    expect(exceptionText({ exceptionDetails: { text: 'Uncaught (in promise)' } })).toBe(
      'Uncaught (in promise)',
    );
    expect(exceptionText({})).toBe('unknown exception');
  });
});

describe('transportVerdict', () => {
  // The 2026-09-11 reading: app.js at ~95 KB/s through the browser.
  const slowPage = { url: 'http://127.0.0.1:1/app/app.js', bytes: 1_450_000, ms: 15_300 };

  it('blames the machine when the control is as slow as the browser', () => {
    const lines = transportVerdict(slowPage, { ...slowPage, ms: 10_800 }).join('\n');
    expect(lines).toMatch(/this is the machine/);
    expect(lines).toMatch(/1,450,000 bytes in 15\.3s/);
  });

  it('blames the browser when this process fetched it at full speed', () => {
    const lines = transportVerdict(slowPage, { ...slowPage, ms: 40 }).join('\n');
    expect(lines).toMatch(/look at the browser/i);
    expect(lines).not.toMatch(/this is the machine/);
  });

  it('gives no verdict it cannot back', () => {
    const lines = transportVerdict(slowPage, null).join('\n');
    expect(lines).toMatch(/no verdict/);
    expect(lines).not.toMatch(/machine|look at the browser/i);
    // …and a fast page with a fast control names no culprit at all.
    const fast = { ...slowPage, ms: 30 };
    expect(transportVerdict(fast, fast).join('\n')).not.toMatch(/machine|browser was slow/i);
  });
});

describe('slowestTransfer', () => {
  it('picks the transfer that cost the most time, not the most bytes', () => {
    const big = { url: 'big', bytes: 9_000_000, ms: 90 };
    const slow = { url: 'slow', bytes: 20_000, ms: 4_000 };
    expect(slowestTransfer([big, slow])?.url).toBe('slow');
    expect(slowestTransfer([])).toBeUndefined();
  });
});

describe('controlFetch', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  /** A loopback server on an OS-picked port that sends `head`, then either
   *  ends or holds the response open forever. */
  async function serve(head: string, end: boolean): Promise<string> {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write(head);
      if (end) res.end();
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/app.js`;
  }

  it('counts every byte of a response that finishes', async () => {
    const url = await serve('x'.repeat(5_000), true);
    expect(await controlFetch(url, 10_000)).toMatchObject({ url, bytes: 5_000, complete: true });
  });

  it('still reports what had arrived when the budget runs out', async () => {
    // The shape of a slow wire: the body starts and does not finish. The rate
    // so far is the reading the verdict needs, so it must not be thrown away.
    const url = await serve('x'.repeat(1_234), false);
    const t = await controlFetch(url, 300);
    expect(t).toMatchObject({ bytes: 1_234, complete: false });
  });

  it('answers null when nothing arrived at all', async () => {
    // Port 0 is never listening: nothing can answer, so there is no rate.
    expect(await controlFetch('http://127.0.0.1:0/app.js', 1_000)).toBeNull();
  });
});
