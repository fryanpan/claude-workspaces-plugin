// @vitest-environment node
/**
 * What a reader does to the map with a mouse, on a plain static page from
 * the packed tarball, in headless Chromium at 1180x820: the four things a
 * page moving off MapLibre needs.
 *
 * 1. Cooperative gestures: a plain wheel over the map scrolls the page and
 *    shows the hint; Ctrl with the wheel zooms the map.
 * 2. A tooltip per marker, point and layer feature, shown on hover.
 * 3. A tap raises `cw-map-feature-click` on the mount element with what was
 *    tapped, and the handle's `setView` moves the map.
 * 4. A card popup: its title is text even when it reads as markup, and its
 *    link is an http(s) link opening in a new tab. A card whose link is not
 *    http(s) is refused at mount with a message.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import { sleep } from '../../../scripts/headless-chrome.ts';
import { type MapPage, mapPage, serveDir, until } from './map-page-harness.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const SUITE_MS = 180_000;
const CASE_MS = 60_000;

const LAT = 37.76;
const LNG = -122.44;
/** Screen pixels per degree at zoom 14 and this latitude, so a feature can
 *  sit a known distance from the centre. */
const PX_LNG = (256 * 2 ** 14) / 360;
const PX_LAT = PX_LNG / Math.cos((LAT * Math.PI) / 180);
/** The point sits this far west of the centre and the road this far south. */
const POINT_WEST = 120;
const ROAD_SOUTH = 90;
/** The two dots of one MultiPoint feature sit this far north, east of the
 *  centre by these amounts. */
const STOPS_NORTH = 100;
const STOPS_EAST = [150, 250];

const TITLE_AS_MARKUP = '<img src=x onerror="window.pwned=1">Harborlight school';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Riverbend interaction</title></head>
<body style="margin: 0 16px; min-height: 3000px">
  <div id="map"></div>
  <div id="bad"></div>
  <div id="plain"></div>
  <script type="module">
    import mount from './node_modules/@claude-workspaces/components/lib/map.js';
    window.clicks = [];
    document.addEventListener('cw-map-feature-click', (e) => window.clicks.push(e.detail));
    window.handle = mount(document.getElementById('map'), {
      center: [${LAT}, ${LNG}],
      zoom: 14,
      height: 420,
      cooperativeGestures: true,
      markers: [{ lat: ${LAT}, lng: ${LNG}, label: 'Harborlight', tooltip: 'Harborlight school',
        popup: { title: ${JSON.stringify(TITLE_AS_MARKUP)}, lines: ['Riverbend district', '412 pupils'],
                 link: { href: 'https://example.org/harborlight', text: 'School page' } } }],
      points: [{ lat: ${LAT}, lng: ${LNG - POINT_WEST / PX_LNG}, tooltip: 'Saltmarsh crash', popup: 'Saltmarsh crash' }],
      layers: [
        { type: 'line', id: 'roads', name: 'Roads', color: '#ff725c', width: 10, clickable: true,
          tooltip: '{name}',
          popup: { title: '{name}', lines: ['{speed} mph'], link: { href: 'https://example.org/roads/{slug}' } },
          data: [{ type: 'Feature', properties: { name: 'Riverbend Ave', speed: 20, slug: 'riverbend' },
            geometry: { type: 'LineString', coordinates: [[-122.52, ${LAT - ROAD_SOUTH / PX_LAT}], [-122.36, ${LAT - ROAD_SOUTH / PX_LAT}]] } }] },
        { type: 'circle', id: 'stops', name: 'Stops', radius: 8, clickable: true, tooltip: '{name}',
          data: { type: 'Feature', properties: { name: 'Bob stop' },
            geometry: { type: 'MultiPoint', coordinates: ${JSON.stringify(STOPS_EAST.map((e) => [LNG + e / PX_LNG, LAT + STOPS_NORTH / PX_LAT]))} } } },
      ],
    });
    // A map without cooperativeGestures, as the board's StreetMap draws.
    window.heard = 0;
    window.addEventListener('wheel', () => window.heard++);
    mount(document.getElementById('plain'), {
      center: [${LAT}, ${LNG}], zoom: 14, height: 240, markers: [{ lat: ${LAT}, lng: ${LNG} }],
    });
    mount(document.getElementById('bad'), {
      markers: [{ lat: ${LAT}, lng: ${LNG}, popup: { title: 'Bob', link: { href: 'javascript:alert(1)' } } }],
    });
  </script>
</body></html>
`;

interface Card {
  title: string | null;
  lines: string[];
  link: { href: string; text: string; target: string; rel: string } | null;
  elements: string[];
}

const readCard = `(() => {
  const p = document.querySelector('#map .cw-map-popup');
  if (!p) return null;
  const a = p.querySelector('a');
  return {
    title: p.querySelector('.cw-map-card-title')?.textContent ?? null,
    lines: [...p.querySelectorAll('.cw-map-card-line')].map((n) => n.textContent),
    link: a ? { href: a.href, text: a.textContent, target: a.target, rel: a.rel } : null,
    elements: [...p.querySelectorAll('*')].map((n) => n.tagName.toLowerCase()),
  };
})()`;

/** The view a map shows, as its slot says once a move ends. */
const readView = (id: string) => `(() => {
  const d = document.querySelector('#${id} .cw-map-slot')?.dataset;
  return d && d.zoom ? { zoom: Number(d.zoom), center: d.center } : null;
})()`;

let dir = '';
let site: Awaited<ReturnType<typeof serveDir>> | undefined;
let page: MapPage | undefined;
const tips: Record<string, string> = {};
const cards: Record<string, Card> = {};
let clicks: Array<{ layer: string; index: number; item: Record<string, unknown> }> = [];
let bad = '';
let pwned: unknown;
let wheel: {
  before: number;
  afterPlain: number;
  scrolled: number;
  hint: string;
  hintGone: boolean;
  afterCtrl: number;
  afterSetView: { zoom: number; center: string };
};
let plain: {
  before: number;
  scrolled: number;
  heard: number;
  afterPlain: number;
  afterCtrl: number;
};

describe.skipIf(CHROME === null)(
  'reader interaction on a static page from the packed tarball',
  () => {
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'components-interaction-'));
      const packed = spawnSync(
        'bun',
        [join(import.meta.dirname, '..', 'scripts', 'pack.ts'), dir],
        {
          encoding: 'utf8',
          timeout: 90_000,
        },
      );
      if (packed.status !== 0) throw new Error(`pack failed:\n${packed.stderr}`);
      const tarball = packed.stdout.trim().split('\n').at(-1) ?? '';
      const root = join(dir, 'site');
      mkdirSync(root);
      copyFileSync(tarball, join(root, basename(tarball)));
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'riverbend-site',
          private: true,
          dependencies: { '@claude-workspaces/components': `file:./${basename(tarball)}` },
        }),
      );
      const install = spawnSync('bun', ['install', '--ignore-scripts'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (install.status !== 0) throw new Error(`install failed:\n${install.stderr}`);
      writeFileSync(join(root, 'index.html'), PAGE);

      site = await serveDir(root);
      const p = await mapPage(CHROME as string, site.origin, 'components-interaction');
      page = p;
      await p.open(`${site.origin}/`, 1180, 820);
      await until('the map drew', () => p.read('#map'));
      bad = await until('the bad map refused', async () => {
        const t = await p.cdp.evaluate(
          `document.querySelector('#bad .cw-map-error')?.textContent ?? null`,
        );
        return typeof t === 'string' ? t : null;
      });

      const centre = async () =>
        (await p.cdp.evaluate(`(() => {
        const r = document.querySelector('#map .cw-map-slot').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`)) as { x: number; y: number };
      const mouse = async (type: string, x: number, y: number, extra: object = {}) =>
        p.cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
      // A spot on the map clear of every feature, to move the pointer away to.
      let away = { x: 0, y: 0 };
      const tooltipAt = async (name: string, x: number, y: number) => {
        // Moved again on every read: the canvas under the points reads a
        // hover at most once per 32ms, so a single move away can go unseen.
        let step = 0;
        await until(`no tooltip before ${name}`, async () => {
          await mouse('mouseMoved', away.x - (step++ % 5), away.y);
          return (await p.cdp.evaluate(
            `document.querySelector('#map .cw-map-tooltip') ? null : true`,
          )) as true | null;
        });
        tips[name] = await until(`the ${name} tooltip`, async () => {
          await mouse('mouseMoved', x, y);
          const t = await p.cdp.evaluate(
            `document.querySelector('#map .leaflet-tooltip .cw-map-tooltip')?.textContent ?? null`,
          );
          return typeof t === 'string' ? t : null;
        });
      };
      const tapAt = async (name: string, x: number, y: number) => {
        await p.cdp.evaluate(`document.querySelector('#map .leaflet-popup-close-button')?.click()`);
        await until(
          `no popup before ${name}`,
          async () =>
            (await p.cdp.evaluate(`document.querySelector('#map .cw-map-popup') ? null : true`)) as
              | true
              | null,
        );
        // A mouse moves to what it taps, so the map knows what it is over.
        await mouse('mouseMoved', x, y);
        for (const type of ['mousePressed', 'mouseReleased']) {
          await mouse(type, x, y, { button: 'left', clickCount: 1 });
        }
        cards[name] = await until(
          `the ${name} popup`,
          async () => (await p.cdp.evaluate(readCard)) as Card | null,
        );
      };

      const c = await centre();
      away = { x: c.x - 300, y: c.y - 150 };
      await tooltipAt('marker', c.x, c.y);
      await tooltipAt('point', c.x - POINT_WEST, c.y);
      await tooltipAt('road', c.x + 200, c.y + ROAD_SOUTH);
      await tapAt('marker', c.x, c.y);
      await tapAt('point', c.x - POINT_WEST, c.y);
      await tapAt('road', c.x + 200, c.y + ROAD_SOUTH);
      const [, eastmost = 0] = STOPS_EAST;
      await tooltipAt('stop', c.x + eastmost, c.y - STOPS_NORTH);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await mouse(type, c.x + eastmost, c.y - STOPS_NORTH, { button: 'left', clickCount: 1 });
      }
      await until('the stop tap', async () =>
        ((await p.cdp.evaluate('window.clicks.length')) as number) === 4 ? true : null,
      );
      clicks = (await p.cdp.evaluate('window.clicks')) as typeof clicks;
      pwned = await p.cdp.evaluate('window.pwned ?? null');
      await p.cdp.evaluate(`document.querySelector('#map .leaflet-popup-close-button')?.click()`);

      const zoomOf = async (id: string) =>
        ((await p.cdp.evaluate(readView(id))) as { zoom: number } | null)?.zoom ?? null;
      const before = await until('a view', () => zoomOf('map'));
      await mouse('mouseWheel', c.x, c.y, { deltaX: 0, deltaY: 300 });
      const hint = await until('the hint', async () => {
        const t = await p.cdp.evaluate(
          `document.querySelector('#map .cw-map-gesture-hint.is-shown')?.textContent ?? null`,
        );
        return typeof t === 'string' ? t : null;
      });
      const scrolled = await until('the page to scroll', async () => {
        const y = (await p.cdp.evaluate('window.scrollY')) as number;
        return y > 0 ? y : null;
      });
      // timed: a wheel Leaflet took would have zoomed inside this window; its
      // own debounce is 40ms and its zoom animation 250ms.
      await sleep(400);
      const afterPlain = await zoomOf('map');
      const hintGone = await until(
        'the hint to go',
        async () =>
          (await p.cdp.evaluate(
            `document.querySelector('#map .cw-map-gesture-hint.is-shown') ? null : true`,
          )) as true | null,
      );
      // The plain wheel scrolled the map's centre off the top of the page.
      await p.cdp.evaluate('window.scrollTo(0, 0)');
      const c2 = await centre();
      // Ctrl is modifier 2.
      await mouse('mouseWheel', c2.x, c2.y, { deltaX: 0, deltaY: -300, modifiers: 2 });
      const afterCtrl = await until('a ctrl-wheel zoom', async () => {
        const z = await zoomOf('map');
        return z !== null && z > before ? z : null;
      });
      // A bad view from the page changes nothing and throws nothing.
      await p.cdp.evaluate(`window.handle.setView([NaN, 1], 11); window.handle.setView('x')`);
      await p.cdp.evaluate('window.handle.setView([37.75, -122.43], 11)');
      const afterSetView = await until('setView to land', async () => {
        const v = (await p.cdp.evaluate(readView('map'))) as {
          zoom: number;
          center: string;
        } | null;
        return v?.zoom === 11 ? v : null;
      });
      wheel = {
        before,
        afterPlain: afterPlain ?? -1,
        scrolled,
        hint,
        hintGone,
        afterCtrl,
        afterSetView,
      };

      // The map without the option: the wheel is the page's, Ctrl or not.
      await p.cdp.evaluate('window.scrollTo(0, 0); window.heard = 0');
      await until('back at the top', async () =>
        (await p.cdp.evaluate('window.scrollY')) === 0 ? true : null,
      );
      const plainBefore = await until('the plain map view', () => zoomOf('plain'));
      const at = (await p.cdp.evaluate(`(() => {
        const r = document.querySelector('#plain .cw-map-slot').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`)) as { x: number; y: number };
      await mouse('mouseWheel', at.x, at.y, { deltaX: 0, deltaY: 120 });
      const plainScrolled = await until('the page to scroll over the plain map', async () => {
        const y = (await p.cdp.evaluate('window.scrollY')) as number;
        return y > 0 ? y : null;
      });
      const heard = (await p.cdp.evaluate('window.heard')) as number;
      // timed: as above, long enough for a wheel zoom to have landed.
      await sleep(400);
      const plainAfter = (await zoomOf('plain')) ?? -1;
      await p.cdp.evaluate('window.scrollTo(0, 0)');
      await until('back at the top again', async () =>
        (await p.cdp.evaluate('window.scrollY')) === 0 ? true : null,
      );
      await mouse('mouseWheel', at.x, at.y, { deltaX: 0, deltaY: -120, modifiers: 2 });
      // timed: as above.
      await sleep(400);
      plain = {
        before: plainBefore,
        scrolled: plainScrolled,
        heard,
        afterPlain: plainAfter,
        afterCtrl: (await zoomOf('plain')) ?? -1,
      };
    }, SUITE_MS);

    afterAll(async () => {
      await page?.close();
      await site?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it(
      'scrolls the page and shows the hint on a plain wheel, and zooms on Ctrl with the wheel',
      () => {
        expect(wheel.hint).toMatch(/(⌘|Ctrl) \+ scroll to zoom the map/);
        expect(wheel.scrolled).toBeGreaterThan(0);
        expect(wheel.afterPlain).toBe(wheel.before);
        expect(wheel.hintGone).toBe(true);
        expect(wheel.afterCtrl).toBeGreaterThan(wheel.before);
        // Without the option the wheel never zooms, and the page hears it.
        expect(plain.scrolled).toBeGreaterThan(0);
        expect(plain.heard).toBeGreaterThan(0);
        expect(plain.afterPlain).toBe(plain.before);
        expect(plain.afterCtrl).toBe(plain.before);
      },
      CASE_MS,
    );

    it(
      "shows each marker's, point's and feature's tooltip on hover, a layer's filled from the feature",
      () => {
        expect(tips).toEqual({
          marker: 'Harborlight school',
          point: 'Saltmarsh crash',
          road: 'Riverbend Ave',
          stop: 'Bob stop',
        });
      },
      CASE_MS,
    );

    it(
      'raises cw-map-feature-click with what was tapped, and setView moves the map',
      () => {
        expect(clicks.map((c) => [c.layer, c.index])).toEqual([
          ['markers', 0],
          ['points', 0],
          ['roads', 0],
          ['stops', 0],
        ]);
        expect(clicks[0]?.item.label).toBe('Harborlight');
        expect(clicks[2]?.item).toEqual({ name: 'Riverbend Ave', speed: 20, slug: 'riverbend' });
        expect(clicks[3]?.item).toEqual({ name: 'Bob stop' });
        expect(wheel.afterSetView).toEqual({ zoom: 11, center: '37.75000,-122.43000' });
      },
      CASE_MS,
    );

    it(
      'draws a card as text with one http(s) link in a new tab, and refuses a card whose link is not http(s)',
      () => {
        expect(cards.marker).toEqual({
          title: TITLE_AS_MARKUP,
          lines: ['Riverbend district', '412 pupils'],
          link: {
            href: 'https://example.org/harborlight',
            text: 'School page',
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          elements: ['strong', 'p', 'p', 'a'],
        });
        expect(pwned).toBe(null);
        expect(cards.point?.elements).toEqual([]);
        expect(cards.road).toEqual({
          title: 'Riverbend Ave',
          lines: ['20 mph'],
          link: {
            href: 'https://example.org/roads/riverbend',
            text: 'https://example.org/roads/riverbend',
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          elements: ['strong', 'p', 'a'],
        });
        expect(bad).toMatch(/link\.href must be an http\(s\) URL/);
        expect(page?.stray).toEqual([]);
      },
      CASE_MS,
    );
  },
);
