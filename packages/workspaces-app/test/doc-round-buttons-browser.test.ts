/**
 * A markdown doc page shows the round comment buttons — the speech bubble
 * and the mic — in the bottom-right corner, the same pair a mock or an app
 * shows, with a thread open and a live `::scratch{block=…}` app frame in view.
 *
 * Reported 14 Nov: "What happened to my commenting tools bottom right?" on a
 * doc beside a live map embed. Doc pages never loaded them. A board embed
 * frame (`cw-embed=1`) still loads none, and nor does a doc opened as one.
 * Real browser, real server, real doc bundle.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type {
  ButtonRead,
  ButtonsView,
  DocButtonsReading,
  Rect,
} from './doc-round-buttons-reading.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

/** A doc bundle build, one launch and three pages. */
const SUITE_MS = 200_000;
const SPAWN_MS = 180_000;
const CASE_MS = 60_000;

/** How far from the screen's right and bottom edges the pair may sit. */
const RIGHT_ROOM = 40;
const BOTTOM_ROOM = 220;

let r: DocButtonsReading;

const overlaps = (a: Rect, b: Rect): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const at = (w: number): ButtonsView => {
  const v = r.views.find((x) => x.width === w);
  if (!v) throw new Error(`no reading at ${w}`);
  return v;
};

function inCorner(b: ButtonRead | null, vw: number, vh: number): void {
  expect(b).not.toBeNull();
  if (!b) return;
  expect(b.onTop).toBe(true);
  expect(b.rect.width).toBeGreaterThanOrEqual(40);
  expect(b.rect.right).toBeLessThanOrEqual(vw);
  expect(b.rect.right).toBeGreaterThan(vw - RIGHT_ROOM);
  expect(b.rect.bottom).toBeLessThanOrEqual(vh);
  expect(b.rect.bottom).toBeGreaterThan(vh - BOTTOM_ROOM);
}

describe.skipIf(CHROME === null)('the round comment buttons on a doc page', () => {
  beforeAll(() => {
    const run = spawnSync(
      'bun',
      [join(import.meta.dirname, 'doc-round-buttons-browser-driver.ts')],
      {
        encoding: 'utf8',
        timeout: SPAWN_MS,
      },
    );
    expect(run.status, run.stderr).toBe(0);
    r = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as DocButtonsReading;
  }, SUITE_MS);

  for (const w of [1180, 430]) {
    it(
      `show at the bottom right at ${w} wide, with a thread open and the app frame in view`,
      () => {
        const v = at(w);
        // The scene the report describes, or the buttons prove nothing.
        expect(v.threadOpen).toBe(true);
        expect(v.frameRendered).toBe(true);
        inCorner(v.buttons.comment, v.buttons.vw, v.buttons.vh);
        inCorner(v.buttons.mic, v.buttons.vw, v.buttons.vh);
      },
      CASE_MS,
    );

    it(
      `keep their size and place as the doc scrolls to its end, and cover none of its last line, at ${w} wide`,
      () => {
        const v = at(w);
        const { comment, mic } = v.buttonsAtEnd;
        expect(comment?.rect).toEqual(v.buttons.comment?.rect);
        expect(mic?.rect).toEqual(v.buttons.mic?.rect);
        expect(v.end).not.toBeNull();
        for (const b of [comment, mic]) {
          if (b && v.end) expect(overlaps(b.rect, v.end)).toBe(false);
        }
      },
      CASE_MS,
    );

    it(
      `leave the new-comment composer's Post button reachable, without moving, at ${w} wide`,
      () => {
        const v = at(w);
        expect(v.composer.post.onTop).toBe(true);
        expect(v.composer.corner.comment?.rect).toEqual(v.buttons.comment?.rect);
        expect(v.composer.corner.mic?.rect).toEqual(v.buttons.mic?.rect);
      },
      CASE_MS,
    );
  }

  it(
    "leave the board's embed frame without a widget of its own",
    () => {
      for (const v of r.views) {
        expect(v.frameRendered).toBe(true);
        expect(v.framesWithWidget).toEqual([]);
      }
    },
    CASE_MS,
  );

  it(
    'are not mounted on a doc opened as an embed',
    () => {
      expect(r.embedPageHasWidget).toBe(false);
    },
    CASE_MS,
  );
});
