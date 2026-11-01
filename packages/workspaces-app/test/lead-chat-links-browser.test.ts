/**
 * A link in the lead's reply opens its doc when tapped, even when the chat
 * redraws under the finger — which it does on every word the listener hears
 * while voice is on, and on every frame about a message (Bryan, 1 Nov: "Your links don't work in chat in
 * board"). Absolute and root-relative links, in a spoken reply and a typed
 * one, on a board's Home at 1180x820 and 430x932.
 * `lead-chat-links-browser-driver.ts` does the tapping against a real server;
 * these cases assert on its JSON.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { LinksRun } from './lead-chat-links-browser-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'lead-chat-links-browser-driver.ts');
/** One bundle build, two launches, eight page loads. */
const SUITE_MS = 200_000;
const SPAWN_MS = 190_000;

let run: LinksRun | null = null;
const result = (): LinksRun => {
  if (!run) throw new Error('the driver printed nothing');
  return run;
};

describe.skipIf(CHROME === null)('a link in the lead’s reply, tapped', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    run = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as LinksRun;
  }, SUITE_MS);

  it('runs every link at both sizes', () => {
    const r = result();
    expect(r.widths.map((w) => w.width)).toEqual([1180, 430]);
    for (const w of r.widths) {
      expect(w.taps.map((t) => t.name)).toEqual([
        'voice-absolute',
        'voice-relative',
        'typed-absolute',
        'typed-relative',
      ]);
    }
  }, 60_000);

  it('draws each link to the doc', () => {
    for (const w of result().widths) {
      for (const t of w.taps) {
        expect(t.href && new URL(t.href).pathname, `${w.width} ${t.name}`).toBe(w.docPath);
      }
    }
  }, 60_000);

  it('presses some links just short of the list’s foot, where the chat follows the conversation down', () => {
    // CONTROL: the hard case is exercised. A redraw there that pulled the
    // list to its foot would move the link out from under the press.
    for (const w of result().widths) {
      expect(w.taps.filter((t) => t.offFoot === 20).length, String(w.width)).toBeGreaterThanOrEqual(
        2,
      );
    }
  }, 60_000);

  it('opens the doc when the chat redraws while the link is pressed', () => {
    for (const w of result().widths) {
      for (const t of w.taps) {
        const reached = [...t.opened, t.pageUrl].map((u) => new URL(u).pathname);
        expect(reached, `${w.width} ${t.name}`).toContain(w.docPath);
      }
    }
  }, 60_000);
});
