/**
 * The comment view on a served three-page mock, in a real browser against a
 * real server, at 1180x820 and 430 wide: every open thread listed by page,
 * the nav's links badged with their open counts, an agent's reply arriving
 * under New in the open view without a reload, another board's review item
 * shown in its thread with a link that opens it, and a tap on a New thread
 * taking the page to that thread's spot.
 *
 * `comment-view-driver.ts` drives the page; this file asserts on what it
 * measured.
 *
 * audit: no-text — the driver measures a running browser and server.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import type { Reading, WidthReading } from './comment-view-driver.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const DRIVER = join(import.meta.dirname, 'comment-view-driver.ts');
const SUITE_MS = 240_000;
const SPAWN_MS = 230_000;
const CASE_MS = 60_000;

let r: Reading | null = null;
const run = (width: string): WidthReading => {
  const got = r?.runs[width];
  if (!got) throw new Error(`the driver printed no run at ${width}`);
  return got;
};

describe.skipIf(CHROME === null)('the comment view on a served mock', () => {
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
    it(
      `lists every open thread under its page, in the nav's order, at ${width} wide`,
      () => {
        const { listed, badges } = run(width);
        expect(listed.map(([section, page, ids]) => [section, page, ids.length])).toEqual([
          ['away', 'Timetable', 1],
          ['page', 'Book', 1],
          ['away', 'Pay', 1],
        ]);
        // The page the reader is on wears no badge; the others say how many.
        expect(badges).toEqual({ Timetable: '1', Book: null, Pay: '1' });
      },
      CASE_MS,
    );

    it(
      `shows an agent's reply under New in the open view, live, at ${width} wide`,
      () => {
        const { reply, opened } = run(width);
        expect(reply).toEqual({ underNew: true, text: true, reloaded: false, hostDot: true });
        // Opened, it stays under New while open on a wide screen (a phone
        // shows it alone). The bar keeps its dot while the Book thread's item
        // is unread, and loses it once that is opened too.
        expect(opened.hostDot).toBe(true);
        expect(run(width).dotAfterAll).toBe(false);
        if (width === '1180') expect(opened.stillUnderNew).toBe(true);
      },
      CASE_MS,
    );

    it(
      `shows another board's review item in its thread, and its link opens it, at ${width} wide`,
      () => {
        const { linked, followed } = run(width);
        expect(linked.headline).toBe('Turn on the tunnel for the Riverbend share?');
        expect(linked.board).toBe('Review item · Saltmarsh');
        expect(linked.href).toMatch(/^\/workspaces\/w-[^/?]+\?task=t-/);
        expect(followed).toBe(linked.href);
      },
      CASE_MS,
    );

    it(
      `takes the page to a tapped thread's spot at ${width} wide`,
      () => {
        const { opened, listed } = run(width);
        const payThread = listed.find(([, page]) => page === 'Pay')?.[2][0];
        expect(opened.hash).toBe('#pay');
        expect(opened.active).toBe(payThread);
        expect(opened.spot, 'the Pay button is drawn').toBeTruthy();
        expect(opened.spot?.top).toBeGreaterThan(0);
        // Above the sheet on a phone; anywhere in the frame beside the column.
        const clear =
          width === '430' ? opened.frameHeight - opened.panelHeight : opened.frameHeight;
        expect(opened.spot?.bottom).toBeLessThanOrEqual(clear);
        if (width === '430') {
          // A phone shows the thread alone, in a sheet half the screen high.
          expect(opened.alone).toBe(true);
          expect(opened.back).toBe('‹ All comments');
          expect(opened.panelHeight / opened.frameHeight).toBeGreaterThan(0.4);
          expect(opened.panelHeight / opened.frameHeight).toBeLessThan(0.6);
        } else {
          expect(opened.alone).toBe(false);
          expect(opened.panelHeight / opened.frameHeight).toBeGreaterThan(0.9);
        }
      },
      CASE_MS,
    );
  }
});
