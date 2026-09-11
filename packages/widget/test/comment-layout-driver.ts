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
/** A comment longer than a saved card shows. */
const LONG =
  'the timetable is missing Sunday, and the Riverbend ferry leaves from the north pier on holidays, not the south one, which the page says twice and the map says once';
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
  /** The last saved card's text: its height, its line height, and the
   *  height its whole text would need. */
  savedText: [number, number, number] | null;
  /** The mode's own buttons that are painted: the FAB and the list. */
  controls: Box[];
  /** The visual viewport: its top offset and height, then its left offset and width. */
  vv: [number, number, number, number];
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
 *  that reaches into it, one low enough that the phone's panel would sit on
 *  it, and one taller than the screen. `#title` is the page heading the phone
 *  banner used to cover, and `#acct` a link in the top-right corner, where the
 *  resting card stands. */
function pageHtml(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font:15px/1.5 system-ui;margin:0;background:#f7f7f2}
 header{background:#2f6b3a;color:#fff;padding:18px 24px}
 h1{margin:0;font-size:22px}
 main{padding:24px}
 #narrow{width:220px;height:70px;background:#eef5ea}
 #low{width:220px}
 #wide{height:70px;margin-top:40px;background:#eef5ea}
 #spacer{height:560px}
 #low{height:60px;background:#eef5ea}
 #tall{height:1200px;margin-top:40px;background:#eef5ea}
 #tail{height:900px}
 #acct{position:absolute;right:48px;top:110px}
</style></head>
<body>
<header><h1 id="title">Harborlight open day</h1></header>
<a id="acct" href="#away">Account</a>
<main>
 <div id="narrow">Ferry times<br>Six sailings</div>
 <div id="wide">The full timetable, across the page</div>
 <div id="spacer"></div>
 <div id="low">Parking</div>
 <div id="tall">The route map</div>
 <div id="tail"></div>
</main>
<${TAG} doc-id="comment-layout" workspace-id="w-demo" user="Test Reviewer" server-url="ws://127.0.0.1:1"></${TAG}>
<script>${bundle}</script>
<script>
window.__posts = [];
document.querySelector('${TAG}').postNewThread = async (_a, text) => {
  window.__posts.push(text);
  // Held open while the test says so, as a slow server would.
  if (window.__hold) return new Promise((r) => { window.__release = r; });
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
  for (const id of ['title', 'narrow', 'wide', 'low', 'acct', 'tall']) el[id] = box(document.getElementById(id));
  const outlined = ['narrow', 'wide', 'low'].find((id) =>
    /solid/.test(document.getElementById(id).style.outline)) ?? null;
  return {
    mode: host.feedbackMode,
    card: box(c),
    snippet: sr.querySelector('.composer-snippet')?.textContent ?? null,
    saved: s ? { box: box(s), text: s.textContent } : null,
    saves: [...sr.querySelectorAll('.saved')].map(box),
    savedText: (() => {
      const all = sr.querySelectorAll('.saved-text');
      const t = all[all.length - 1];
      if (!t) return null;
      // One line's height, under the same styles: a sibling holding one word.
      const one = t.cloneNode();
      one.textContent = 'x';
      t.after(one);
      const line = one.getBoundingClientRect().height;
      one.remove();
      return [t.getBoundingClientRect().height, line, t.scrollHeight];
    })(),
    controls: [...sr.querySelectorAll('.fab, .fab-list')].map(box).filter(Boolean),
    vv: [visualViewport.offsetTop, visualViewport.height, visualViewport.offsetLeft, visualViewport.width].map(Math.round),
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
  /** Esc from script: after a CDP Escape, headless Chromium stops acking the
   *  next touch (the page itself stays responsive), so the key is dispatched
   *  where the mode listens for it. */
  const escape = async (): Promise<void> => {
    await cdp.evaluate(`dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
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
    // The resting card stands over the corner where the page keeps its
    // account link. Cancel puts it away, and the link can be tapped.
    await tap(`${SHADOW}.querySelector('.composer .cancel')`);
    await look('restCancelled');
    await tap(el('acct'));
    await look('onAcct');
    await tap(`${SHADOW}.querySelector('.composer .cancel')`);
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
    await type(LONG);
    await enter();
    await look('posted2');
    // A finger on the saved card, while the resting card's field has focus.
    await tap(`${SHADOW}.querySelector('.saved')`);
    await look('savedTapped');
    // Zoomed in and scrolled down inside the zoom: the visual viewport is
    // half the height and starts partway down the layout viewport, as it does
    // when an iPad's keyboard pushes the page up.
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    await settle();
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 300,
      y: 300,
      deltaX: 0,
      deltaY: 1000,
    });
    await settle();
    await look('zoomed');
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await cdp.evaluate('scrollTo(0, 0)');
    await settle();
    // An iPad turned to portrait mid-comment, and back.
    await tap(el('wide'));
    await type('Riverbend stop');
    await turn(820, 1180);
    // Typing goes on where it left off, not at the start of the draft.
    await type(' shelter');
    await look('portrait');
    await turn(width, height);
    await look('landscape');
    // An element low on the screen, whose card level with it would reach the
    // FAB and the list button in the corner.
    await cdp.evaluate(`scrollTo(0, document.getElementById('low').offsetTop - ${height} + 90)`);
    await settle();
    await tap(el('low'));
    await look('onLowDesk');
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
  if (width > 1100) {
    // Done, Esc and the FAB's X each close over a typed draft; opening the
    // element again brings it back.
    await tap(fab);
    await look('reentered');
    await tap(el('low'));
    await look('reopened');
    await escape();
    await look('escaped');
    await tap(el('low'));
    await look('reopenedEsc');
    await tap(fab);
    await tap(fab);
    await tap(el('low'));
    await look('reopenedX');
    // Done while that draft is posting. A post that fails leaves the words
    // waiting on the element; one that lands leaves nothing to post twice.
    await cdp.evaluate('window.__hold = true');
    await enter();
    await tap(done);
    await cdp.evaluate('window.__release(false)');
    await settle();
    await tap(fab);
    await tap(el('low'));
    await look('afterFailed');
    await enter();
    await tap(done);
    await cdp.evaluate('window.__release(true)');
    await settle();
    await tap(fab);
    await tap(el('low'));
    await look('afterPending');
    // Words kept on two elements, then a tap from one to the other: each card
    // shows its own, and the words it leaves wait on theirs.
    await cdp.evaluate('scrollTo(0, 0)');
    await settle();
    await tap(el('narrow'));
    await type('Ferry note');
    await escape();
    await tap(el('wide'));
    await type('Timetable note');
    await escape();
    await tap(el('narrow'));
    await tap(el('wide'));
    await look('switched');
    await tap(el('narrow'));
    await look('switchedBack');
    // The same from the card the mode rests in, whose words are the page's.
    await escape();
    await tap(done);
    await tap(fab);
    await type('About the day');
    await tap(el('wide'));
    await look('fromRest');
    await escape();
    await tap(done);
    await tap(fab);
    await look('restBack');
    // Two quick posts on an element low on the screen: the second card and
    // the first one's saved card stack, and so do the two saved cards.
    await tap(`${SHADOW}.querySelector('.composer .cancel')`);
    await cdp.evaluate('window.__hold = false');
    await cdp.evaluate(`scrollTo(0, document.getElementById('low').offsetTop - ${height} + 90)`);
    await settle();
    await tap(el('low'));
    await type('Lot A');
    await enter();
    await tap(el('low'));
    await type('Lot B');
    await look('lowOpen');
    await enter();
    await look('lowTwice');
    // An element taller than the screen, whose card has nowhere clear to go.
    await cdp.evaluate(`scrollTo(0, document.getElementById('tall').offsetTop - 100)`);
    await settle();
    await tap(el('tall'));
    await look('onTall');
    await tap(done);
  }
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
