#!/usr/bin/env bun
/**
 * Comment pins on a data mock that is redrawn, and then revised in place,
 * driven in headless Chromium.
 *
 * Spawned by `pins-revised.test.ts`, which reads the JSON it prints. A report
 * with a heading, a paragraph, a table and a chart its script draws is
 * commented on in five places, one of them on a screen the page keeps hidden.
 * The page then redraws its chart and rebuilds a table row, as a data mock
 * does when a control moves. Last, a second version of the page is loaded
 * with the same anchors, as a reload shows a mock its author revised: a
 * section and a table row are added above the commented elements, and the
 * chart sits in a new panel. The words of everything commented on are
 * unchanged.
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

/** [left, top, right, bottom], rounded. */
export type Box = [number, number, number, number];

export interface Look {
  /** Each thread's pin: painted at all, and where its tip is. */
  pins: Record<string, { shown: boolean; tip: [number, number] } | undefined>;
  /** Each commented element's box, found by its words; null with no box. */
  el: Record<string, Box | null>;
  h3s: number;
  rows: number;
}

export interface Reading {
  looks: Record<string, Look>;
  /** The chart label and the table cell the pins first stood on were
   *  replaced by the redraw, not kept. */
  replaced: { label: boolean; cell: boolean };
}

/** Each thread, and the tag and words of the element it is on. */
export const TARGETS = {
  't-heading': ['h3', 'Riverbend high water by month'],
  't-para': ['p', 'The June peak is the highest since the gauge opened.'],
  't-cell': ['td', '4.1 m'],
  't-label': ['text', 'June peak'],
  't-hidden': ['p', 'Harborlight neap tides'],
} as const;

function pageHtml(bundle: string, revised: boolean): string {
  const added = revised
    ? '<h3>Harborlight low water by month</h3><p>Falls fastest in autumn.</p>'
    : '';
  const chart = revised
    ? '<div class="panel"><div id="chart"></div></div>'
    : '<div id="chart"></div>';
  const row = revised ? '<tr><td>April</td><td>3.5 m</td></tr>' : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
 body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#1d1d1b}
 main{max-width:720px;padding:24px 32px}
 td{padding:4px 16px;border-bottom:1px solid #ddd}
</style></head>
<body>
<main>
 <h1>Saltmarsh tide report</h1>
 <p>Readings from the Riverbend gauge.</p>
 ${added}
 <h3>Riverbend high water by month</h3>
 ${chart}
 <p>The June peak is the highest since the gauge opened.</p>
 <table><tbody>${row}<tr><td>May</td><td>3.8 m</td></tr><tr><td>June</td><td>4.1 m</td></tr></tbody></table>
 <div hidden><p>Harborlight neap tides</p></div>
</main>
<${TAG} doc-id="pins-revised" workspace-id="w-demo" user="Alice" server-url="ws://127.0.0.1:1"></${TAG}>
<script>
// The chart is drawn afresh each time, as a plotting library does.
window.draw = (h) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '400');
  svg.setAttribute('height', '120');
  const g = document.createElementNS(ns, 'g');
  const bar = document.createElementNS(ns, 'rect');
  for (const [k, v] of [['x', 40], ['y', 110 - h], ['width', 60], ['height', h]]) bar.setAttribute(k, v);
  const label = document.createElementNS(ns, 'text');
  label.setAttribute('x', '120');
  label.setAttribute('y', '60');
  label.textContent = 'June peak';
  g.append(bar, label);
  svg.append(g);
  document.getElementById('chart').replaceChildren(svg);
};
window.draw(80);
</script>
<script>${bundle}</script>
</body></html>`;
}

function buildWidget(dir: string): string {
  const entry = join(dir, 'entry.ts');
  const src = (p: string) => JSON.stringify(join(import.meta.dirname, p));
  writeFileSync(
    entry,
    `import ${src('../src/widget.ts')};\n` +
      `import { createThread } from ${src('../../core/src/schema.ts')};\n` +
      `import { createAnchor } from ${src('../../core/src/anchor/element.ts')};\n` +
      'Object.assign(window, { __core: { createThread, createAnchor } });\n',
  );
  const built = spawnSync('bun', ['build', entry, '--target=browser'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr}`);
  return built.stdout;
}

/** The element of `tag` whose words are exactly `words`. */
const FIND =
  '(tag, words) => [...document.querySelectorAll(tag)].find((e) => e.textContent.trim() === words)';

const LOOK = `(() => {
  const find = ${FIND};
  const targets = ${JSON.stringify(TARGETS)};
  const pins = {};
  for (const p of document.querySelectorAll('.cfw-pin')) {
    const r = p.getBoundingClientRect();
    pins[p.dataset.threadId] = {
      shown: getComputedStyle(p).display !== 'none' && r.width > 0,
      tip: [Math.round(r.left + 22), Math.round(r.top + 33)],
    };
  }
  const el = {};
  for (const [id, [tag, words]] of Object.entries(targets)) {
    const e = find(tag, words);
    const r = e && e.getBoundingClientRect();
    el[id] = r && (r.width || r.height) ? [r.left, r.top, r.right, r.bottom].map(Math.round) : null;
  }
  return { pins, el, h3s: document.querySelectorAll('h3').length, rows: document.querySelectorAll('tr').length };
})()`;

async function drive(cdp: Cdp, dir: string, bundle: string): Promise<Reading> {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const load = async (revised: boolean) => {
    const html = join(dir, revised ? 'revised.html' : 'first.html');
    writeFileSync(html, pageHtml(bundle, revised));
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `file://${html}` });
    await loaded;
    await sleep(500);
  };
  const looks: Record<string, Look> = {};
  const look = async (name: string) => {
    // Two frames for the render the page's change scheduled, then the rAF
    // loop that places pins.
    await sleep(400);
    looks[name] = (await cdp.evaluate(LOOK)) as Look;
  };
  // The anchors are made on the first version and kept as the server keeps
  // them, through JSON.
  await load(false);
  const anchors = (await cdp.evaluate(`(() => {
    const find = ${FIND};
    const out = {};
    for (const [id, [tag, words]] of Object.entries(${JSON.stringify(TARGETS)})) {
      out[id] = JSON.parse(JSON.stringify(window.__core.createAnchor(find(tag, words))));
    }
    return out;
  })()`)) as Record<string, unknown>;
  const put = `((anchors) => {
    const doc = document.querySelector('${TAG}').client.ydoc;
    const who = { id: 'known-r', name: 'Alice', kind: 'known', color: '#7a5cc4' };
    for (const [threadId, anchor] of Object.entries(anchors)) {
      window.__core.createThread(doc, { threadId, anchor, createdBy: who, firstComment: { id: 'c-' + threadId, text: 'Note on ' + threadId } });
    }
  })(${JSON.stringify(anchors)})`;
  await cdp.evaluate(put);
  await look('static');

  // A control moves: the chart is drawn again and a table row rebuilt.
  const replaced = (await cdp.evaluate(`(async () => {
    const find = ${FIND};
    const label = find('text', 'June peak');
    const cell = find('td', '4.1 m');
    window.draw(100);
    cell.parentElement.replaceWith(cell.parentElement.cloneNode(true));
    return { label: !label.isConnected, cell: !cell.isConnected };
  })()`)) as Reading['replaced'];
  await look('redrawn');

  // The author revises the mock in place; the reader reloads it.
  await load(true);
  await cdp.evaluate(put);
  await look('revised');
  return { looks, replaced };
}

const runId = `pinsrev${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-pins-revised-'));
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
  const reading = await drive(cdp, dir, bundle);
  cdp.close();
  console.log(JSON.stringify(reading));
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
