#!/usr/bin/env bun
/**
 * A reviewer commenting on a page in comment mode, driven with real input.
 *
 * Spawned by `widget-comment-layout.test.ts`, which reads the JSON it prints.
 * Its own process for the reason `post-click-driver.ts` gives: one browser
 * launch with a cleanup that must run even when a case throws. The input has
 * to be REAL for the focus case in particular — a finger's tap is followed,
 * after its pointerup, by compatibility mouse events the browser itself
 * generates, and a synthesized `pointerup` (what the happy-dom suite fires)
 * has none of them, so it cannot see focus being taken back off the field.
 * `Input.dispatchTouchEvent` is a tap the browser routes, compatibility
 * events and all.
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

const TAG = 'claude-feedback-widget';
const SHADOW = `document.querySelector('${TAG}').shadowRoot`;

/** [left, top, right, bottom], rounded. */
export type Box = [number, number, number, number];

/** One look at the page, taken after an input settled. */
export interface Look {
  mode: boolean;
  /** The open composer, or null. */
  card: Box | null;
  snippet: string | null;
  /** The saved card still showing its tick, or null. */
  saved: { box: Box; text: string } | null;
  /** Every saved card on screen. */
  saves: Box[];
  /** Each leader line's two ends. */
  lines: Array<[number, number, number, number]>;
  /** The banner when it is painted, else null. */
  banner: Box | null;
  /** Is the banner's tick showing? */
  tick: boolean;
  /** Is the FAB painted? */
  fab: boolean;
  /** What has focus inside the widget, e.g. "TEXTAREA", or "page". */
  focus: string;
  /** The field's text. */
  draft: string | null;
  /** The id of the element wearing the picker's outline, if any. */
  outlined: string | null;
  scrollY: number;
  /** Where the page elements the case taps are, right now. */
  el: Record<string, Box>;
  posts: string[];
}

export interface Reading {
  width: number;
  height: number;
  looks: Record<string, Look>;
}

/** Elements a comment goes on: one that stops short of the right margin, one
 *  that reaches into it, and one low enough that the phone's panel would sit
 *  on it. `#title` is the page heading the phone banner used to cover. */
function pageHtml(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font:15px/1.5 system-ui;margin:0;background:#f7f7f2}
 header{background:#2f6b3a;color:#fff;padding:18px 24px}
 h1{margin:0;font-size:22px}
 main{padding:24px}
 #narrow{width:220px;height:70px;background:#eef5ea}
 #wide{height:70px;margin-top:40px;background:#eef5ea}
 #spacer{height:560px}
 #low{height:60px;background:#eef5ea}
 #tail{height:900px}
</style></head>
<body>
<header><h1 id="title">Harborlight open day</h1></header>
<main>
 <div id="narrow">Ferry times</div>
 <div id="wide">The full timetable, across the page</div>
 <div id="spacer"></div>
 <div id="low">Parking</div>
 <div id="tail"></div>
</main>
<${TAG} doc-id="comment-layout" workspace-id="w-demo" user="Test Reviewer" server-url="ws://127.0.0.1:1"></${TAG}>
<script>${bundle}</script>
<script>
window.__posts = [];
document.querySelector('${TAG}').postNewThread = async (_a, text) => {
  window.__posts.push(text);
  return true;
};
</script>
</body></html>`;
}

function buildWidget(dir: string): string {
  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    `import ${JSON.stringify(join(import.meta.dirname, '../src/widget.ts'))};\n`,
  );
  const built = spawnSync('bun', ['build', entry, '--target=browser'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr}`);
  return built.stdout;
}

const LOOK = `(() => {
  const host = document.querySelector('${TAG}');
  const sr = host.shadowRoot;
  const box = (e) => {
    if (!e || getComputedStyle(e).display === 'none') return null;
    const r = e.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
  };
  const c = sr.querySelector('.composer');
  const s = sr.querySelector('.saved');
  const b = sr.querySelector('.picker-banner');
  const t = b && b.querySelector('.tick');
  const lines = [...sr.querySelectorAll('.leader polyline')].map((p) =>
    p.getAttribute('points').split(/[ ,]/).map((n) => Math.round(Number(n))));
  const ae = sr.activeElement;
  const el = {};
  for (const id of ['title', 'narrow', 'wide', 'low']) el[id] = box(document.getElementById(id));
  const outlined = ['narrow', 'wide', 'low'].find((id) =>
    /solid/.test(document.getElementById(id).style.outline)) ?? null;
  return {
    mode: host.feedbackMode,
    card: box(c),
    snippet: sr.querySelector('.composer-snippet')?.textContent ?? null,
    saved: s ? { box: box(s), text: s.textContent } : null,
    saves: [...sr.querySelectorAll('.saved')].map(box),
    lines,
    banner: box(b),
    tick: !!t && !t.hidden,
    fab: !!box(sr.querySelector('.fab')),
    focus: document.activeElement === host ? (ae ? ae.tagName : 'host') : 'page',
    draft: sr.querySelector('.composer textarea')?.value ?? null,
    outlined,
    scrollY: Math.round(scrollY),
    el,
    posts: window.__posts,
  };
})()`;

async function drive(cdp: Cdp, dir: string, bundle: string, width: number, height: number) {
  const html = join(dir, `page-${width}.html`);
  writeFileSync(html, pageHtml(bundle));
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `file://${html}` });
  await loaded;
  await sleep(500);

  const centre = async (expr: string): Promise<{ x: number; y: number }> => {
    const p = (await cdp.evaluate(`(() => { const e = ${expr}; if (!e) return null;
      const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`)) as {
      x: number;
      y: number;
    } | null;
    if (!p) throw new Error(`nothing at ${expr}`);
    return p;
  };
  const settle = () => sleep(250);
  /** Turn the device: the same page at another viewport. */
  const turn = async (w: number, h: number): Promise<void> => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await settle();
  };
  /** A finger: touchStart, touchEnd — the browser makes the rest. */
  const tap = async (expr: string): Promise<void> => {
    const p = await centre(expr);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
    await sleep(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle();
  };
  const hover = async (expr: string): Promise<void> => {
    const p = await centre(expr);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, pointerType: 'mouse' });
    await settle();
  };
  const type = async (text: string): Promise<void> => {
    await cdp.send('Input.insertText', { text });
    await settle();
  };
  const enter = async (): Promise<void> => {
    const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...k });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    await settle();
  };
  const looks: Record<string, Look> = {};
  const look = async (name: string): Promise<void> => {
    looks[name] = (await cdp.evaluate(LOOK)) as Look;
  };
  const fab = `${SHADOW}.querySelector('.fab')`;
  const done = `${SHADOW}.querySelector('.picker-cancel')`;
  const el = (id: string) => `document.getElementById('${id}')`;

  await tap(fab);
  await look('entered');
  if (width > 1100) {
    await hover(el('narrow'));
    await look('hovered');
    await tap(el('narrow'));
    await type('ferry times are wrong');
    await look('onNarrow');
    await enter();
    await look('posted');
    await tap(el('wide'));
    await look('onWide');
    // A second post while the first one's saved card still shows.
    await type('the timetable is missing Sunday');
    await enter();
    await look('posted2');
    // An iPad turned to portrait mid-comment, and back.
    await tap(el('wide'));
    await type('Riverbend stop');
    await turn(820, 1180);
    // Typing goes on where it left off, not at the start of the draft.
    await type(' shelter');
    await look('portrait');
    await turn(width, height);
    await look('landscape');
  } else {
    await tap(el('narrow'));
    await type('ferry times are wrong');
    await look('onNarrow');
    await enter();
    await look('posted');
    await tap(el('low'));
    await look('onLow');
    // While a draft is open the panel offers Cancel where Done was — the two
    // never sit together — so leaving from here is Cancel, then Done.
    await tap(`${SHADOW}.querySelector('.composer .cancel')`);
    await look('cancelled');
  }
  await tap(done);
  await look('done');
  return { width, height, looks };
}

const runId = `commentlayout${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-comment-layout-'));
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
  const readings: Reading[] = [];
  readings.push(await drive(cdp, dir, bundle, 1180, 820));
  readings.push(await drive(cdp, dir, bundle, 430, 932));
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
