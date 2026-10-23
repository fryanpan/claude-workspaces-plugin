/**
 * An attachment framed on its project's frame hostname, on a domain that is
 * not the board's, cannot read or set a cookie on the board, cannot have its
 * scripts loaded by another project's frame, and an app door there still
 * takes a comment through the widget.
 *
 * `frame-host-driver.ts` opens two attachments from a real board server in
 * headless Chromium, with the board on `harborlight.board.localhost` and the
 * frame hostname on `harborlight.frames.localhost`. The board's page plants a
 * cookie and a stored value first and reads them back itself: that is the
 * control, so an empty read in the frame is the origin boundary and not a
 * value that was never there. A page on the board's own domain sets a cookie
 * there the way the mock tries to: that is the control for the mock's
 * attempt.
 * What the server answers on the frame hostname, and to whom, is
 * `packages/server/test/frame-host.test.ts`.
 *
 * audit: no-text — the driver reads a running server and page; nothing here
 * reads a source file, a bundle or a stylesheet.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
// Types only: importing a value would run the driver in this process.
import type { FrameHostReading } from './frame-host-driver.ts';

const FRAME_PLANT = 'cw_frame_plant';
const CONTROL_PLANT = 'cw_control_plant';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'frame-host-driver.ts');
/** A widget build, two servers, one launch and three pages. */
const SUITE_MS = 120_000;
const SPAWN_MS = 110_000;

const PLANTED = 'harborlight-planted';

let reading: FrameHostReading;

describe.skipIf(CHROME === null)('attachments on the frame-only hostname', () => {
  beforeAll(() => {
    const r = spawnSync('bun', [DRIVER], { encoding: 'utf8', timeout: SPAWN_MS });
    expect(r.status, r.stderr).toBe(0);
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    reading = JSON.parse(last) as FrameHostReading;
  }, SUITE_MS);

  it("CONTROL: the board's own page reads the cookie and the value it planted", () => {
    expect(reading.board.cookie).toContain(`cw_board_probe=${PLANTED}`);
    expect(reading.board.stored).toBe(PLANTED);
  });

  it("cannot read the board's cookies or storage from inside the frame", () => {
    const frame = reading.frame;
    expect(frame, 'the frame never reported').not.toBeNull();
    expect(frame?.origin).not.toBe(reading.board.origin);
    expect(frame?.cookie).not.toContain(PLANTED);
    expect(frame?.stored).toBeNull();
    expect(frame?.parentCookie).toBe('refused:SecurityError');
    expect(frame?.parentStored).toBe('refused:SecurityError');
    expect(frame?.topCookie).toBe('refused:SecurityError');
  });

  it("loads only by trading the board's ticket, which leaves its address", () => {
    expect(reading.frame?.search).toBe('?cw-frame=1');
  });

  it("CONTROL: a page on the board's own domain sets a cookie the board receives", () => {
    expect(reading.boardAfter).toContain(`${CONTROL_PLANT}=1`);
  });

  it("cannot set a cookie on the board's domain or hostname from inside the frame", () => {
    expect(reading.boardAfter).not.toContain(FRAME_PLANT);
  });

  it("CONTROL: the door's script loads from its own frame hostname", () => {
    expect(reading.door.upstreamHits).toBeGreaterThan(0);
  });

  it("refuses the door's script to another project's frame", () => {
    expect(reading.riverbend.loaded).toBe(false);
    expect(reading.riverbend.upstreamHits).toBe(0);
  });

  it("has storage of its own, holding the reader's name the board handed it", () => {
    expect(reading.frame?.ownStorage).toBe(true);
    expect(reading.frame?.name).toBe('Sample Reader');
  });

  it("loads an app door's own script and stylesheet on the frame hostname", () => {
    expect(reading.door.origin).toBe(reading.frame?.origin);
    expect(reading.door.script).toBe(true);
    expect(reading.door.color).toBe('rgb(4, 5, 6)');
  });

  it('posts a comment typed through the widget in the app door, as the reader', () => {
    expect(reading.door.posted).toEqual({
      text: 'Riverbend berth prices look right',
      author: 'Sample Reader',
    });
  });
});
