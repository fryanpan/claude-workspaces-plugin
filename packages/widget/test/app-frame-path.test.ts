/**
 * An attached app whose router has no base path takes the door's prefix off
 * the frame's address. The frame stays on the app when the app's own script
 * reloads it and when a faded pin restores a thread's address, with nothing
 * changed in the app, in both frames the board hands out.
 *
 * `app-frame-path-driver.ts` runs the app, a board server and headless
 * Chromium, and this file asserts on what it read. What the server answers,
 * and to whom, is `packages/server/test/frame-left-door.test.ts`.
 *
 * audit: no-text — the driver reads a running page; nothing here reads a
 * source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { FrameReading, Reading } from './app-frame-path-driver.ts';

/** The browser these cases may launch, or null to skip them. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'app-frame-path-driver.ts');
/** A widget build, one launch and two walks of three steps each. */
const SUITE_MS = 170_000;
const SPAWN_MS = 160_000;

let reading: Reading;

describe.skipIf(CHROME === null)('an app that takes the prefix off its own address', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    reading = JSON.parse(last) as Reading;
  }, SUITE_MS);

  const frames: [string, () => FrameReading][] = [
    ['the opaque frame on the board hostname', () => reading.opaque],
    ['the frame on the frame-only hostname', () => reading.frameHost],
  ];

  describe.each(frames)('in %s', (_name, frame) => {
    it('CONTROL: the frame sits outside the door before anything is reloaded', () => {
      expect(frame().opened.address).toBe('/insights?tab=a&cw-frame=1');
    });

    it("shows the app at the same path after the app's script reloads the frame", () => {
      const after = frame().reloaded;
      expect(after.text).toBeNull();
      expect([after.app, after.route, after.query]).toEqual([
        true,
        '/insights',
        '?tab=a&cw-frame=1',
      ]);
    });

    it('shows the app at the same path when the address had dropped its query too', () => {
      const after = frame().reloadedBare;
      expect(after.text).toBeNull();
      expect([after.app, after.route, after.query]).toEqual([true, '/insights', '?cw-frame=1']);
    });

    it('CONTROL: the stored context is the address the widget read, with no prefix', () => {
      expect(frame().storedContext).toBe('/insights?tab=b&cw-frame=1');
      expect(frame().pinDimmed).toBe(true);
    });

    it("stays on the app at the thread's path when the faded pin is tapped, and shows the thread", () => {
      const after = frame().pinTapped;
      expect(after.text).toBeNull();
      expect([after.app, after.route]).toEqual([true, '/insights']);
      expect(after.query).toContain('tab=b');
      expect(frame().threadShown).toBe(true);
    });
  });

  it("gives a top-level visit to the same address the board's own answer", () => {
    expect(reading.topLevel).toEqual({ status: 404, body: 'not found' });
  });
});
