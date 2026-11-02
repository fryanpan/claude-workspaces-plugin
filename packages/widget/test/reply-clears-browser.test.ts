/**
 * A reply sent on a mock posts once and leaves the reply box empty — with
 * Enter, with the Reply button, and from the comment view on a multi-page
 * mock — in a real browser against a real server, at 1180x820 and 430x932.
 *
 * Bryan, on a mock: "when I type a reply, and then hit enter on this page The
 * reply text stays and also appears above in the thread." The page's own copy
 * of the reply, arriving by socket before the POST answered, redrew the
 * comment view with the box's words carried into the new popover.
 *
 * `reply-clears-driver.ts` drives the page and builds that order every time;
 * this file asserts on what it measured.
 *
 * audit: no-text — the driver measures a running browser and server.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { Reading } from './reply-clears-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'reply-clears-driver.ts');
const SUITE_MS = 240_000;
const SPAWN_MS = 230_000;

let r: Reading | null = null;

describe.skipIf(CHROME === null)('a reply sent on a mock', () => {
  beforeAll(() => {
    const out = spawnSync('bun', [DRIVER], {
      encoding: 'utf8',
      timeout: SPAWN_MS,
      env: process.env,
    });
    expect(out.status, out.stderr).toBe(0);
    r = JSON.parse(out.stdout.trim().split('\n').pop() ?? '') as Reading;
  }, SUITE_MS);

  for (const width of ['1180', '430']) {
    for (const how of ['enter', 'button', 'view'] as const) {
      it(`at ${width}, sent with ${how}: posts once and empties the box`, () => {
        const got = r?.runs[width]?.[how];
        if (!got) throw new Error(`the driver printed no ${how} send at ${width}`);
        // CONTROL: the reply reached the page before its POST answered,
        // the order that kept the words.
        expect(got.echoFirst, 'the reply showed before the POST answered').toBe(true);
        expect(got.stored, 'the reply stored').toBe(1);
        expect(got.shown, 'the reply shown in the thread').toBe(1);
        expect(got.box).toBe('');
      });
    }
  }
});
