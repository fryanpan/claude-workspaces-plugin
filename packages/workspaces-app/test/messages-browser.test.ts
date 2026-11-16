/**
 * M10's done-when, in two real browsers against a real server: a message
 * Alice sends from her open board reaches Bob's already-open board within
 * 1s, with no reload.
 *
 * `packages/server/test/messages-browser-driver.ts` opens the board in two
 * headless Chromes, one per person, each holding its own session cookie.
 * Bob opens Messages on Alice's channel; Alice opens Messages, picks Bob and
 * sends; Bob's page is polled for the line with a 1s limit. Then Bob closes
 * and reopens the chat, which must still be on Alice's channel.
 *
 * audit: no-text — the driver reads a running server and pages; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { MessagesReading } from '../../server/test/messages-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, '../../server/test/messages-browser-driver.ts');
/** A client build, two launches and two page loads. */
const SUITE_MS = 180_000;
const SPAWN_MS = 170_000;

let r: MessagesReading;

describe.skipIf(CHROME === null)('Messages between two open boards', () => {
  beforeAll(() => {
    const run = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as MessagesReading;
  }, SUITE_MS);

  it('shows the Messages item to the owner and to a member', () => {
    expect(r.navShown).toEqual({ alice: true, bob: true });
  });

  it("lists #general and Bob in Alice's channels", () => {
    expect(r.aliceChannels).toEqual(['#general', 'Bob']);
  });

  it("Alice's line reaches Bob's already-open board within 1s", () => {
    expect(r.arrivedWithinOneSecond).toBe(true);
    expect(r.aliceShowsLine).toBe(true);
  });

  it("reopens on Alice's channel with the line still there", () => {
    expect(r.reopened).toEqual({ heading: 'Alice', hasLine: true });
  });

  it('the pages threw nothing', () => {
    expect(r.errors).toEqual([]);
  });
});
