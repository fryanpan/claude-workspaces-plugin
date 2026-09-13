#!/usr/bin/env bun
/**
 * Comment pins on a mock, driven with real input in headless Chromium.
 *
 * Spawned by `widget-pins.test.ts`, which reads the JSON it prints. A
 * reviewer taps two spots in comment mode — white space on a container the
 * size of the page, and the words of a status chip — and posts on each. The
 * page is then loaded again, as a reload would, and the two anchors are put
 * back exactly as they were posted (through JSON, as the server stores them),
 * beside threads the page could not have had a tap for: a resolved one, a
 * second on the same element, five on one heading, one on a dot with no
 * words, one with an open review item, one on a screen the page keeps hidden, and one on
 * an element the page's script has not built yet.
 *
 * Each look records what a reader sees: every pin's tip, its state, whether it
 * is painted, the colours its drop is painted in, and every run of page text
 * on screen, so the test can say whether a drop sits on any of it.
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

export interface Pin {
  id: string;
  state: string;
  /** Painted at all? */
  shown: boolean;
  /** Where its tip is: the box's (22, 33), as the stylesheet draws it. */
  tip: [number, number];
  text: string;
  /** The drop's fill, its fill image and its ring colour. */
  paint: [string, string, string];
}

export interface Look {
  pins: Pin[];
  /** Every line box of page text on screen. */
  text: Box[];
  el: Record<string, Box | null>;
  /** The open thread popover's text, or null. */
  popover: string | null;
}

export interface Reading {
  width: number;
  height: number;
  /** Where each tap landed, and the element the page says is under it. */
  taps: Record<string, { x: number; y: number; under: string }>;
  /** The anchors as the widget posted them. */
  anchors: Array<{ at?: { x: number; y: number }; fingerprint: { id?: string; tag: string } }>;
  /** The page-sized container's box, for the control. */
  main: Box;
  looks: Record<string, Look>;
}

function pageHtml(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#1d1d1b}
 #board-main{min-height:100vh;box-sizing:border-box;padding:120px 32px 40px}
 h1{font-size:24px;margin:0 0 4px}
 .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin-top:16px}
 .card{background:#fff;border:1px solid #e2e0da;border-radius:10px;padding:14px 16px}
 .card h2{font-size:16px;margin:0 0 6px}
 .card p{margin:0 0 6px}
 .chip{display:inline-block;font-size:12px;padding:2px 8px;border-radius:99px;background:#e6f0ea;color:#1f6b3d}
 .dot{display:inline-block;width:10px;height:10px;margin-left:8px;border-radius:50%;background:#2da44e}
 .book{margin-top:6px;padding:6px 12px;border-radius:6px;border:1px solid #1f2a33;background:#1f2a33;color:#fff;font:inherit}
</style></head>
<body>
<div id="board-main">
 <h1 id="title">Dock schedule</h1>
 <div class="cards">
  <section class="card"><h2>Berth 4 — Riverbend ferry</h2><p>Arrives 06:40, departs 07:15.</p><span class="chip" id="b4-chip">Confirmed</span><br><button class="book" id="b4-book">Change slot</button></section>
  <section class="card"><h2 id="b2-title">Berth 2 — pilot boat</h2><p>On call from 12:00.</p><span class="chip">Tentative</span><i class="dot" id="b2-dot"></i></section>
 </div>
 <div id="screen-tides" hidden><p id="tide-high">High water 14:20</p></div>
 <div id="later"></div>
</div>
<${TAG} doc-id="pins" workspace-id="w-demo" user="Harborlight Reviewer" server-url="ws://127.0.0.1:1"></${TAG}>
<script>${bundle}</script>
<script>
window.__anchors = [];
document.querySelector('${TAG}').postNewThread = async (anchor) => {
  window.__anchors.push(JSON.parse(JSON.stringify(anchor)));
  return true;
};
</script>
</body></html>`;
}

function buildWidget(dir: string): string {
  const entry = join(dir, 'entry.ts');
  const src = (p: string) => JSON.stringify(join(import.meta.dirname, p));
  writeFileSync(
    entry,
    `import ${src('../src/widget.ts')};\n` +
      `import { createThread, setStatus } from ${src('../../core/src/schema.ts')};\n` +
      `import { createAnchor } from ${src('../../core/src/anchor/element.ts')};\n` +
      'Object.assign(window, { __core: { createThread, setStatus, createAnchor } });\n',
  );
  const built = spawnSync('bun', ['build', entry, '--target=browser'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr}`);
  return built.stdout;
}

const LOOK = `(() => {
  const box = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
  };
  const pins = [...document.querySelectorAll('.cfw-pin')].map((p) => {
    const r = p.getBoundingClientRect();
    const b = getComputedStyle(p, '::before');
    return {
      id: p.dataset.threadId,
      state: p.dataset.state,
      shown: getComputedStyle(p).display !== 'none' && r.width > 0,
      tip: [Math.round(r.left + 22), Math.round(r.top + 33)],
      text: p.textContent,
      paint: [b.backgroundColor, b.backgroundImage, b.borderTopColor],
    };
  });
  const text = [];
  const walk = document.createTreeWalker(document.getElementById('board-main'), NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.textContent.trim()) continue;
    range.selectNodeContents(n);
    for (const q of range.getClientRects()) text.push([q.left, q.top, q.right, q.bottom].map(Math.round));
  }
  const el = {};
  for (const id of ['title', 'b4-chip', 'b4-book', 'b2-title', 'b2-dot', 'tide-high', 'walk-step']) el[id] = box(document.getElementById(id));
  const pop = ${SHADOW}.querySelector('.thread-popover');
  return { pins, text, el, popover: pop ? pop.textContent : null };
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
  const load = async () => {
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `file://${html}` });
    await loaded;
    await sleep(500);
  };
  const settle = () => sleep(250);
  const tapAt = async (x: number, y: number): Promise<void> => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle();
  };
  const centre = async (expr: string) =>
    (await cdp.evaluate(`(() => { const r = (${expr}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`)) as {
      x: number;
      y: number;
    };
  const under = (x: number, y: number) =>
    cdp.evaluate(
      `(() => { const e = document.elementFromPoint(${x}, ${y}); return e.id || e.className || e.tagName; })()`,
    ) as Promise<string>;
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

  // --- Commenting: two taps, two posts. ---
  await load();
  const main =
    (await cdp.evaluate(`(() => { const r = document.getElementById('board-main').getBoundingClientRect();
    return [r.left, r.top, r.right, r.bottom].map(Math.round); })()`)) as Box;
  const taps: Reading['taps'] = {};
  const fab = await centre(`${SHADOW}.querySelector('.fab')`);
  await tapAt(fab.x, fab.y);
  // White space above the title: the page-sized container is what is there.
  const space = { x: Math.round(width * 0.8), y: 70 };
  taps.space = { ...space, under: await under(space.x, space.y) };
  await tapAt(space.x, space.y);
  await cdp.send('Input.insertText', { text: 'Room for the tide table here' });
  await enter();
  // The words of a status chip.
  const chip = await centre(`document.getElementById('b4-chip')`);
  taps.chip = { ...chip, under: await under(chip.x, chip.y) };
  await tapAt(chip.x, chip.y);
  await cdp.send('Input.insertText', { text: 'Confirmed by whom?' });
  await enter();
  const done = await centre(`${SHADOW}.querySelector('.picker-cancel')`);
  await tapAt(done.x, done.y);
  const anchors = (await cdp.evaluate('window.__anchors')) as Reading['anchors'];

  // --- Reloaded: the posted anchors, and four the page could not tap. ---
  await load();
  await cdp.evaluate(`(() => {
    const { createThread, setStatus, createAnchor } = window.__core;
    const w = document.querySelector('${TAG}');
    const doc = w.client.ydoc;
    const who = { id: 'known-r', name: 'Harborlight Reviewer', kind: 'known', color: '#7a5cc4' };
    const put = (threadId, anchor, text, review) =>
      createThread(doc, { threadId, anchor, createdBy: who, firstComment: { id: 'c-' + threadId, text, review } });
    const posted = ${JSON.stringify(anchors)};
    put('t-space', posted[0], 'Room for the tide table here');
    put('t-chip', posted[1], 'Confirmed by whom?');
    put('t-resolved', createAnchor(document.getElementById('b2-title')), 'Say it is on call');
    setStatus(doc, 't-resolved', 'resolved');
    // A second comment on the same title, with no tap to place it either.
    put('t-title', createAnchor(document.getElementById('b2-title')), 'And the berth number');
    // Its tapped point is on the button, just under the chip: a drop standing
    // there would sit on the chip's word.
    put('t-review', { ...createAnchor(document.getElementById('b4-book')), at: { x: 0.3, y: 0.15 } },
      'What does this open?', { shape: 'review', headline: 'Sheet or new page?' });
    // A dot with no words in it, and more threads on the heading than it has
    // edges to stand them at.
    put('t-dot', createAnchor(document.getElementById('b2-dot')), 'Is green right here?');
    for (let i = 1; i <= 5; i++) put('t-crowd-' + i, createAnchor(document.getElementById('title')), 'Heading note ' + i);
    put('t-tide', createAnchor(document.getElementById('tide-high')), 'Show the height too');
    const later = document.getElementById('later');
    later.innerHTML = '<p id="walk-step">Walk the pier</p>';
    const walk = createAnchor(document.getElementById('walk-step'));
    later.innerHTML = '';
    put('t-walk', walk, 'Which pier?');
  })()`);
  await sleep(600);
  await look('reloaded');
  // The pin is what reopens its thread.
  const chipPin = looks.reloaded?.pins.find((p) => p.id === 't-chip');
  if (chipPin?.shown) {
    await tapAt(chipPin.tip[0], chipPin.tip[1] - 14);
    await look('pinTapped');
    await cdp.evaluate(`${SHADOW}.querySelector('.thread-popover .close')?.click()`);
  }
  // The page opens the hidden screen, then builds the one that did not exist.
  await cdp.evaluate(`document.getElementById('screen-tides').hidden = false`);
  await sleep(400);
  await look('tidesShown');
  await cdp.evaluate(
    `document.getElementById('later').innerHTML = '<p id="walk-step">Walk the pier</p>'`,
  );
  await sleep(600);
  await look('walkBuilt');
  return { width, height, taps, anchors, main, looks };
}

const runId = `pins${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-pins-'));
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
