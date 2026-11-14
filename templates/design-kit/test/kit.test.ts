/**
 * The trial's board lines, driven in a headless Chrome:
 *   1. both pages restyle from the theme file alone (same markup bytes)
 *   2. the compact setting tightens Workspaces at 1180x820 and 430 wide
 *   3. a popover opens on a TAP on a phone-sized page with touch emulation
 *
 * Real-browser cases run only when CW_BROWSER_TESTS is set; `bun run test`
 * in this folder sets it. Screenshots go to $KIT_SHOTS_DIR when set.
 *
 * audit: no-text — every assertion reads a rendered page; nothing here reads
 * a source file, a bundle or a stylesheet.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { buildKit } from '../scripts/build.ts';
import { IPAD, KIT_READY, PHONE, type Page, type Viewport, launchPage } from '../scripts/drive.ts';
import { startServer } from '../scripts/serve.ts';

const CHROME = chromeForSuite();
const SHOTS = process.env.KIT_SHOTS_DIR;
const PAGES = ['review-list', 'tasks'] as const;

let server: ReturnType<typeof startServer>;
let page: Page;
const url = (theme: string, name: string, query = '') =>
  `http://127.0.0.1:${server.port}/t/${theme}/${name}.html${query}`;

async function show(theme: string, name: string, viewport: Viewport, query = ''): Promise<void> {
  await page.open(url(theme, name, query), viewport);
  await page.waitFor(KIT_READY);
}

async function shot(file: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot(join(SHOTS, file));
}

/** Computed values a theme decides, read off the rendered page. */
interface Look {
  font: string;
  brandFill: string;
  cardRadius: string;
  cardPadding: number;
  buttonHeight: number;
}
const READ_LOOK = `(() => {
  const brand = document.querySelector('wa-button[variant="brand"]');
  const part = brand.shadowRoot.querySelector('[part~="button"]');
  const card = document.querySelector('wa-card');
  const body = card.shadowRoot.querySelector('[part~="body"]');
  return {
    font: getComputedStyle(document.body).fontFamily,
    brandFill: getComputedStyle(part).backgroundColor,
    cardRadius: getComputedStyle(card).borderTopLeftRadius,
    cardPadding: parseFloat(getComputedStyle(body).paddingTop),
    buttonHeight: brand.getBoundingClientRect().height,
  };
})()`;

const MAIN_HEIGHT = `document.querySelector('main').getBoundingClientRect().height`;

describe.skipIf(CHROME === null)('design-kit trial in a headless browser', () => {
  beforeAll(async () => {
    await buildKit();
    server = startServer(0);
    page = await launchPage(CHROME ?? undefined);
  }, 60_000);

  afterAll(async () => {
    await page?.close();
    server?.stop(true);
  });

  for (const name of PAGES) {
    test(`${name}: a theme file alone restyles the page`, async () => {
      const markup = await Promise.all(
        ['workspaces', 'harborlight'].map(async (t) => (await fetch(url(t, name))).text()),
      );
      expect(markup[0]).toBe(markup[1] as string);

      await show('workspaces', name, IPAD);
      const workspaces = await page.evaluate<Look>(READ_LOOK);
      await shot(`restyle-${name}-workspaces.png`);
      await show('harborlight', name, IPAD);
      const harborlight = await page.evaluate<Look>(READ_LOOK);
      await shot(`restyle-${name}-harborlight.png`);

      expect(workspaces.font).toContain('-apple-system');
      expect(harborlight.font).toContain('Georgia');
      expect(workspaces.brandFill).not.toBe(harborlight.brandFill);
      expect(workspaces.cardRadius).not.toBe(harborlight.cardRadius);
      expect(harborlight.cardPadding).toBeGreaterThan(workspaces.cardPadding);
    }, 60_000);
  }

  for (const [label, viewport] of [
    ['1180x820', IPAD],
    ['430 wide', PHONE],
  ] as const) {
    test(`compact tightens Workspaces at ${label}`, async () => {
      await show('workspaces', 'review-list', viewport);
      const comfortable = await page.evaluate<Look>(READ_LOOK);
      const tallComfortable = await page.evaluate<number>(MAIN_HEIGHT);
      await shot(`compact-off-${viewport.width}.png`);
      await show('workspaces', 'review-list', viewport, '?density=compact');
      expect(await page.evaluate<string>('document.documentElement.dataset.density')).toBe(
        'compact',
      );
      const compact = await page.evaluate<Look>(READ_LOOK);
      const tallCompact = await page.evaluate<number>(MAIN_HEIGHT);
      await shot(`compact-on-${viewport.width}.png`);

      expect(compact.cardPadding).toBeLessThan(comfortable.cardPadding);
      expect(compact.buttonHeight).toBeLessThan(comfortable.buttonHeight);
      expect(tallCompact).toBeLessThan(tallComfortable);
    }, 60_000);
  }

  test('compact does nothing on a site whose theme leaves it out', async () => {
    await show('harborlight', 'review-list', IPAD);
    const off = await page.evaluate<Look>(READ_LOOK);
    await show('harborlight', 'review-list', IPAD, '?density=compact');
    const on = await page.evaluate<Look>(READ_LOOK);
    expect(on).toEqual(off);
  }, 60_000);

  for (const [name, trigger, popover] of [
    ['review-list', '#details-1', '#popover-1'],
    ['tasks', '#owner-t1', '#task-t1 wa-popover'],
  ] as const) {
    test(`${name}: a tap opens the popover on a phone`, async () => {
      await show('workspaces', name, PHONE);
      await page.evaluate(`(() => {
        window.__touches = 0;
        addEventListener('touchstart', () => { window.__touches++; }, { capture: true });
      })()`);
      expect(await page.evaluate<boolean>(`matchMedia('(pointer: coarse)').matches`)).toBe(true);
      expect(await page.evaluate<boolean>(`document.querySelector('${popover}').open`)).toBe(false);

      const at = await page.evaluate<{ x: number; y: number }>(`(() => {
        const r = document.querySelector('${trigger}').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      await page.tap(at.x, at.y);

      expect(await page.waitFor<boolean>(`document.querySelector('${popover}').open`)).toBe(true);
      const shown = await page.waitFor<{ w: number; h: number; inView: boolean }>(`(() => {
        const body = document.querySelector('${popover}').shadowRoot.querySelector('[part~="body"]');
        const r = body.getBoundingClientRect();
        const ok = r.width > 0 && r.height > 0;
        return ok && { w: r.width, h: r.height, inView: r.left >= 0 && r.right <= innerWidth };
      })()`);
      expect(shown.inView).toBe(true);
      expect(await page.evaluate<number>('window.__touches')).toBe(1);
      await shot(`popover-tap-${name}-430.png`);
    }, 60_000);
  }

  test('tasks: a tap on Mark done updates the Preact state', async () => {
    await show('workspaces', 'tasks', PHONE);
    expect(await page.evaluate<string>(`document.querySelector('#open-count').textContent`)).toBe(
      '2 open',
    );
    const at = await page.evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('#toggle-t1').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await page.tap(at.x, at.y);
    expect(
      await page.waitFor<boolean>(`document.querySelector('#open-count').textContent === '1 open'`),
    ).toBe(true);
  }, 60_000);
});
