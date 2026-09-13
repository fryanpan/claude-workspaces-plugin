#!/usr/bin/env bun
/**
 * Pointing at a mock's own bottom bar in comment mode, in headless Chromium
 * at 1180x820 with a mouse and 430x932 with a finger.
 *
 * The page is a fictional Saltmarsh settings screen with a fixed four-tab nav
 * along the bottom, the shape of the mock the bug was reported on: at 430 the
 * phone prompt lay over the whole nav and took every tap, and at 1180 the FAB
 * sat on the last tab, where a tap left the mode. The mockup round chevrons
 * are drawn too, since they sit in the same band. Every tab is tapped at its
 * centre and near both ends; the chevrons, the FAB and the prompt's Done are
 * tapped; the nav is hidden and shown again to see the controls follow it.
 *
 * Two more pages hold the rest still: one with no bar, where nothing may move,
 * and at 430 one wider than the screen, panned, for the prompt's edges.
 *
 * And at 1180, a page with a left rail and no bar, whose last button rests
 * under the chevrons: in comment mode a tap there anchors to the button, and
 * out of it the chevrons still step the rounds.
 *
 * Spawned by `widget-page-bar.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was measured in a running browser.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Browser,
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
} from '../../../scripts/headless-chrome.ts';
import { chromeLaunchArgs, profilesOfRun, resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import type { Box } from './panel-edge-driver.ts';

const TAG = 'claude-feedback-widget';
const HOST = `document.querySelector('${TAG}')`;
const SHADOW = `${HOST}.shadowRoot`;
const TABS = ['home', 'trips', 'inbox', 'settings'] as const;

/** What one tap on the page did. */
export interface Tap {
  name: string;
  x: number;
  y: number;
  /** A composer opened. */
  composer: boolean;
  /** The id of the nearest page element with one around what it is about. */
  about: string | null;
  /** Comment mode was still on afterwards. */
  mode: boolean;
}

export interface BarLook {
  nav: Box | null;
  fab: Box | null;
  list: Box | null;
  chevrons: Box | null;
  /** In comment mode: the prompt, and its Done button. */
  banner: Box | null;
  done: Box | null;
  /** In comment mode, whether the widget's own hit test at the FAB's centre
   *  (1180) or at Done's (430) finds that control. */
  controlOnTop: boolean;
  taps: Tap[];
  /** Tapping the FAB (1180) or Done (430) left the mode. */
  controlLeftMode: boolean;
  /** The version the chevrons asked for, if a tap reached them. */
  went: unknown[];
  /** The FAB, and the chevrons, once the nav is hidden, then shown again. */
  hidden: { fab: Box | null; chevrons: Box | null };
  shown: { fab: Box | null; chevrons: Box | null };
}

export interface PlainLook {
  fab: Box | null;
  list: Box | null;
  chevrons: Box | null;
  banner: Box | null;
}

export interface WideLook {
  innerWidth: number;
  /** The visual viewport: left, top, width, height. */
  vv: [number, number, number, number];
  banner: Box | null;
}

export interface RailLook {
  talk: Box | null;
  chevrons: Box | null;
  /** Out of the mode, the page's own hit test at the button's centre lands
   *  in the chevrons — they really do cover it. */
  covered: boolean;
  /** In comment mode, a tap at the button's centre. */
  tap: Tap;
  /** Out of the mode again, a tap on the back chevron: what it asked for,
   *  and whether the mode came on or a composer opened. */
  went: unknown[];
  mode: boolean;
  composer: boolean;
}

export interface Reading {
  width: number;
  height: number;
  bar: BarLook;
  plain: PlainLook;
  wide: WideLook | null;
  rail: RailLook | null;
}

type Variant = 'bar' | 'plain' | 'wide' | 'rail';

function pageHtml(bundle: string, variant: Variant): string {
  const tabs = TABS.map((t) => `<a id="t-${t}" href="#${t}"><span>*</span>${t}</a>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font:15px/1.5 system-ui;margin:0;background:#f7f7f2;padding-bottom:72px}
 header{padding:16px 20px;background:#fff}
 #wide{width:640px;height:48px;background:#fff}
 main{padding:20px}
 .row{background:#fff;border:1px solid #e3e3dc;border-radius:8px;padding:14px;margin:0 0 10px}
 nav{position:fixed;left:0;right:0;bottom:0;height:64px;background:#fff;border-top:1px solid #ccc;display:flex}
 nav a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#234;text-decoration:none}
 body.bare nav{display:none}
 aside{position:fixed;left:0;top:0;bottom:0;width:88px;background:#fff;border-right:1px solid #ccc}
 #rail-talk{position:absolute;left:22px;bottom:28px;width:44px;height:44px;border:0;border-radius:22px;background:#234;color:#fff}
</style></head>
<body${variant === 'rail' ? ' style="padding-left:88px"' : ''}>
${variant === 'wide' ? '<div id="wide"></div>' : ''}
${variant === 'rail' ? '<aside id="rail"><button id="rail-talk" aria-label="Hold to talk">o</button></aside>' : ''}
<header><h1 style="margin:0;font-size:20px">Saltmarsh settings</h1></header>
<main><div class="row" id="r-tides">Tide alerts</div><div class="row">Riverbend moorings</div></main>
${variant === 'bar' ? `<nav id="tabs">${tabs}</nav>` : ''}
<${TAG} doc-id="page-bar" workspace-id="w-demo" user="Reviewer" server-url="ws://127.0.0.1:1"></${TAG}>
<script>${bundle}</script>
</body></html>`;
}

/** The shipped widget, plus the mockup chevrons a served mock adds. */
function buildWidget(dir: string): string {
  const entry = join(dir, 'entry.ts');
  const src = (f: string) => JSON.stringify(join(import.meta.dirname, '../src', f));
  writeFileSync(
    entry,
    `import ${src('widget.ts')};\n` +
      `import * as live from ${src('mockup-live.ts')};\n` +
      '(window as unknown as { __live: unknown }).__live = live;\n',
  );
  const built = spawnSync('bun', ['build', entry, '--target=browser'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr}`);
  return built.stdout;
}

const BOX = `(e) => {
  if (!e || getComputedStyle(e).display === 'none') return null;
  const r = e.getBoundingClientRect();
  return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
}`;

async function until(cdp: Cdp, expr: string, tries = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await cdp.evaluate(`!!(${expr})`)) return true;
    await sleep(50);
  }
  return false;
}

const frames = (cdp: Cdp) =>
  cdp.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');

let pages = 0;
async function load(cdp: Cdp, dir: string, html: string, width: number, height: number) {
  pages += 1;
  const file = join(dir, `page-${pages}.html`);
  writeFileSync(file, html);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', {
    enabled: width <= 1100,
    maxTouchPoints: 5,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `file://${file}` });
  await loaded;
  if (!(await until(cdp, `${SHADOW}?.querySelector('.fab')`))) throw new Error('no FAB');
  // Two rounds, as a served mock with history has, so the chevrons show.
  await cdp.evaluate(`(() => {
    window.__went = [];
    __live.renderControl({ docId: 'page-bar', workspaceId: 'w-demo', version: null, versions: [1, 2] },
      (v) => window.__went.push(v));
    __live.keepControlLifted?.();
  })()`);
  await frames(cdp);
}

async function tap(cdp: Cdp, x: number, y: number, touch: boolean): Promise<void> {
  if (touch) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return;
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0,
    });
  }
}

const MODE = `document.body.classList.contains('cfw-feedback-mode')`;
const box = async (cdp: Cdp, expr: string) =>
  (await cdp.evaluate(`(${BOX})(${expr})`)) as Box | null;
const centre = (b: Box): [number, number] => [
  Math.round((b[0] + b[2]) / 2),
  Math.round((b[1] + b[3]) / 2),
];

async function enterMode(cdp: Cdp): Promise<void> {
  await cdp.evaluate(`${MODE} || ${SHADOW}.querySelector('.fab').click()`);
  if (!(await until(cdp, MODE))) throw new Error('comment mode never came on');
  await frames(cdp);
}

/** Tap, then wait for a composer — or, when none comes, a short while. */
async function tapFor(cdp: Cdp, name: string, x: number, y: number, touch: boolean): Promise<Tap> {
  await tap(cdp, x, y, touch);
  await until(cdp, `${SHADOW}.querySelector('.composer') || !${MODE}`, 20);
  const got = (await cdp.evaluate(`(() => {
    const t = ${HOST}.hoverEl;
    return {
      composer: !!${SHADOW}.querySelector('.composer'),
      about: t ? (t.closest('[id]')?.id ?? null) : null,
      mode: ${MODE},
    };
  })()`)) as Pick<Tap, 'composer' | 'about' | 'mode'>;
  // Back to the mode, armed, with nothing open and the address unchanged.
  await cdp.evaluate(`(() => {
    ${SHADOW}.querySelector('.composer .cancel')?.click();
    if (location.hash) history.replaceState(null, '', location.pathname);
  })()`);
  await enterMode(cdp);
  return { name, x, y, ...got };
}

async function barLook(cdp: Cdp, touch: boolean): Promise<BarLook> {
  const nav = await box(cdp, `document.getElementById('tabs')`);
  const fab = await box(cdp, `${SHADOW}.querySelector('.fab')`);
  const list = await box(cdp, `${SHADOW}.querySelector('.fab-list')`);
  const chevrons = await box(cdp, `document.querySelector('[data-cw-mock-versions]')`);
  await enterMode(cdp);
  const banner = await box(cdp, `${SHADOW}.querySelector('.picker-banner')`);
  const done = await box(cdp, `${SHADOW}.querySelector('.picker-cancel')`);

  const taps: Tap[] = [];
  for (const t of TABS) {
    const b = (await box(cdp, `document.getElementById('t-${t}')`)) as Box;
    const [cx, cy] = centre(b);
    taps.push(await tapFor(cdp, `${t} centre`, cx, cy, touch));
    taps.push(await tapFor(cdp, `${t} left end`, b[0] + 10, cy, touch));
    taps.push(await tapFor(cdp, `${t} right end`, b[2] - 10, cy, touch));
    // Where the FAB and the chevrons rest, at the nav's height: on the tab
    // if they stand above the bar, on the control if they sit over it.
    for (const [what, over] of [
      ['the FAB', fab],
      ['the chevrons', chevrons],
    ] as const) {
      const x = over && centre(over)[0];
      if (x && x > b[0] && x < b[2])
        taps.push(await tapFor(cdp, `${t} under ${what}`, x, cy, touch));
    }
  }
  const prev = await box(cdp, `document.querySelector('[data-cw-mock-versions] button')`);
  if (prev) taps.push(await tapFor(cdp, 'chevron', ...centre(prev), touch));

  const control = (touch ? done : fab) as Box;
  const sel = touch ? '.picker-cancel' : '.fab';
  const [kx, ky] = centre(control);
  const controlOnTop = (await cdp.evaluate(
    `${SHADOW}.elementFromPoint(${kx}, ${ky})?.closest('${sel}') === ${SHADOW}.querySelector('${sel}')`,
  )) as boolean;
  await tap(cdp, kx, ky, touch);
  const controlLeftMode = await until(cdp, `!${MODE}`, 40);
  const went = (await cdp.evaluate('window.__went')) as unknown[];
  // Off the FAB, and its hover grow finished, so what moves next is the bar.
  if (!touch) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 300 });
  await until(cdp, `getComputedStyle(${SHADOW}.querySelector('.fab')).transform === 'none'`, 40);

  const look = async () => ({
    fab: await box(cdp, `${SHADOW}.querySelector('.fab')`),
    chevrons: await box(cdp, `document.querySelector('[data-cw-mock-versions]')`),
  });
  // A full-screen view with no tab bar, then back: the controls follow.
  const fabBottom = `${SHADOW}.querySelector('.fab').getBoundingClientRect().bottom`;
  const before = (await cdp.evaluate(fabBottom)) as number;
  await cdp.evaluate(`document.body.classList.add('bare')`);
  await until(cdp, `${fabBottom} !== ${before}`, 40);
  await frames(cdp);
  const hidden = await look();
  const low = (await cdp.evaluate(fabBottom)) as number;
  await cdp.evaluate(`document.body.classList.remove('bare')`);
  await until(cdp, `${fabBottom} !== ${low}`, 40);
  await frames(cdp);
  const shown = await look();

  return {
    nav,
    fab,
    list,
    chevrons,
    banner,
    done,
    controlOnTop,
    taps,
    controlLeftMode,
    went,
    hidden,
    shown,
  };
}

async function plainLook(cdp: Cdp): Promise<PlainLook> {
  const fab = await box(cdp, `${SHADOW}.querySelector('.fab')`);
  const list = await box(cdp, `${SHADOW}.querySelector('.fab-list')`);
  const chevrons = await box(cdp, `document.querySelector('[data-cw-mock-versions]')`);
  await enterMode(cdp);
  const banner = await box(cdp, `${SHADOW}.querySelector('.picker-banner')`);
  return { fab, list, chevrons, banner };
}

async function railLook(cdp: Cdp): Promise<RailLook> {
  const talk = await box(cdp, `document.getElementById('rail-talk')`);
  const chevrons = await box(cdp, `document.querySelector('[data-cw-mock-versions]')`);
  const [x, y] = centre(talk as Box);
  const covered = (await cdp.evaluate(
    `!!document.elementFromPoint(${x}, ${y})?.closest('[data-cw-mock-versions]')`,
  )) as boolean;
  await enterMode(cdp);
  const tap0 = await tapFor(cdp, 'hold to talk', x, y, false);
  await cdp.evaluate(`${SHADOW}.querySelector('.picker-cancel')?.click()`);
  if (!(await until(cdp, `!${MODE}`))) throw new Error('comment mode never went off');
  const prev = (await box(cdp, `document.querySelector('[data-cw-mock-versions] button')`)) as Box;
  // Only this tap's asks count: on main's sources the tap in the mode above
  // reached the chevrons too.
  await cdp.evaluate('window.__went = []');
  await tap(cdp, ...centre(prev), false);
  await until(cdp, 'window.__went.length > 0', 40);
  return {
    talk,
    chevrons,
    covered,
    tap: tap0,
    went: (await cdp.evaluate('window.__went')) as unknown[],
    mode: (await cdp.evaluate(MODE)) as boolean,
    composer: (await cdp.evaluate(`!!${SHADOW}.querySelector('.composer')`)) as boolean,
  };
}

async function wideLook(cdp: Cdp): Promise<WideLook> {
  await enterMode(cdp);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 200,
    y: 300,
    deltaX: 600,
    deltaY: 0,
  });
  await until(cdp, 'visualViewport.offsetLeft > 0', 40);
  await frames(cdp);
  const [innerWidth, l, t, w, h] = (await cdp.evaluate(
    '[innerWidth, visualViewport.offsetLeft, visualViewport.offsetTop, visualViewport.width, visualViewport.height].map(Math.round)',
  )) as number[];
  return {
    innerWidth: innerWidth as number,
    vv: [l, t, w, h] as [number, number, number, number],
    banner: await box(cdp, `${SHADOW}.querySelector('.picker-banner')`),
  };
}

const runId = `pagebar${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-page-bar-'));
let browser: Browser | undefined;
const stop = (proc: ChildProcess | undefined): void => {
  try {
    proc?.kill();
  } catch {}
};
try {
  const bundle = buildWidget(dir);
  browser = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
    60_000,
    runId,
    (b) => {
      browser = b;
    },
  );
  const cdp = await Cdp.connect(await pageSocketUrl(browser.port, 30_000));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const shots = process.env.PAGE_BAR_SHOTS;
  const shot = async (name: string) => {
    if (!shots) return;
    const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    writeFileSync(join(shots, `${name}.png`), Buffer.from(png.data, 'base64'));
  };
  const readings: Reading[] = [];
  for (const [width, height] of [
    [1180, 820],
    [430, 932],
  ] as const) {
    const touch = width <= 1100;
    await load(cdp, dir, pageHtml(bundle, 'bar'), width, height);
    await shot(`${width}-resting`);
    await enterMode(cdp);
    await shot(`${width}-mode`);
    await cdp.evaluate(`${SHADOW}.querySelector('.picker-cancel')?.click()`);
    await until(cdp, `!${MODE}`);
    const bar = await barLook(cdp, touch);
    await load(cdp, dir, pageHtml(bundle, 'plain'), width, height);
    const plain = await plainLook(cdp);
    let wide: WideLook | null = null;
    let rail: RailLook | null = null;
    if (touch) {
      await load(cdp, dir, pageHtml(bundle, 'wide'), width, height);
      wide = await wideLook(cdp);
    } else {
      await load(cdp, dir, pageHtml(bundle, 'rail'), width, height);
      rail = await railLook(cdp);
    }
    readings.push({ width, height, bar, plain, wide, rail });
  }
  cdp.close();
  console.log(JSON.stringify(readings));
} finally {
  stop(browser?.proc);
  await sleep(400);
  rmSync(dir, { recursive: true, force: true });
  for (const name of profilesOfRun(readdirSync(tmpdir()), runId)) {
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    } catch {}
  }
}
process.exit(0);
