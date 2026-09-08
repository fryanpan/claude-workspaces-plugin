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
 *     wrong host on a machine whose tailnet name resolved.
 */
import { describe, expect, it } from 'vitest';
import { exceptionText, listeningPort, parseArgs } from './client-boot-check';

describe('parseArgs', () => {
  it('defaults to a port above the reserved band and a ten-second mount ceiling', () => {
    const o = parseArgs([]);
    // 8787, 8791, 7900 and 7902 are owned by other fleet services and bin.ts
    // refuses them; 8800 is above all of them.
    expect(o.port).toBe(8800);
    expect(o.timeoutMs).toBe(10_000);
    expect(o.keep).toBe(false);
    expect(o.shot).toBeUndefined();
  });

  it('takes an explicit port, timeout, screenshot and --keep', () => {
    const o = parseArgs(['--port', '8850', '--timeout', '4000', '--shot', '/tmp/x.png', '--keep']);
    expect(o).toMatchObject({ port: 8850, timeoutMs: 4000, shot: '/tmp/x.png', keep: true });
  });

  it('refuses a port or timeout that is not a positive integer', () => {
    expect(() => parseArgs(['--port', '0'])).toThrow(/--port/);
    expect(() => parseArgs(['--timeout', 'soon'])).toThrow(/--timeout/);
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
