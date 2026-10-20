#!/usr/bin/env bun
/**
 * Where a thread's reply box and Reply button land when the reader opens the
 * thread from the Feedback panel's list, driven in headless Chromium at
 * 1180x820 and 430x900.
 *
 * Spawned by `reply-box.test.ts`, which reads the JSON it prints. The page is
 * a long mock with three threads: one near its top, and two on the last
 * paragraphs, where a scroll to the middle cannot bring the element any
 * higher than the bottom of the screen. One of those holds an agent's reply
 * with a decision to answer, which the popover draws above the reply box
 * (`widget-ask.ts`), as on a served mock.
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
  /** The window: innerWidth, innerHeight. */
  win: [number, number];
  pop: Box | null;
  box: Box | null;
  send: Box | null;
  /** The popover again, half a second later. */
  popLater: Box | null;
  /** The commented element, after the list's scroll. */
  el: Box | null;
}

/** Keyed `<width>x<height>:<thread id>`. */
export type Reading = Record<string, Look>;

const SIZES = [
  [1180, 820],
  [430, 900],
] as const;
const THREADS = ['t-top', 't-bottom', 't-ask'] as const;

const filler = Array.from(
  { length: 30 },
  (_, i) =>
    `<h2>Section ${i + 1}</h2><p>The Riverbend timetable for week ${i + 1} lists every sailing and its pier.</p>`,
).join('');

function pageHtml(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#1d1d1b}main{max-width:720px;padding:24px 32px}</style>
</head><body><main>
 <h1>Saltmarsh ferry timetable</h1>
 <p id="top">Harborlight pier opens at dawn.</p>
 ${filler}
 <p id="ask">The winter sailings stop at Riverbend.</p>
 <p id="bottom">Saltmarsh ferry runs hourly.</p>
</main>
<${TAG} doc-id="reply-box" workspace-id="w-demo" user="Alice" server-url="ws://127.0.0.1:1"></${TAG}>
<script>${bundle}</script>
</body></html>`;
}

/** The widget, with the list and the asks a served mock loads beside it. */
function buildWidget(dir: string): string {
  const entry = join(dir, 'entry.ts');
  const src = (p: string) => JSON.stringify(join(import.meta.dirname, p));
  writeFileSync(
    entry,
    `import ${src('../src/widget.ts')};\n` +
      `import { mountPageList } from ${src('../src/widget-page-list.ts')};\n` +
      `import { mountAsks } from ${src('../src/widget-ask.ts')};\n` +
      `import { createThread, postReply } from ${src('../../core/src/schema.ts')};\n` +
      `import { createAnchor } from ${src('../../core/src/anchor/element.ts')};\n` +
      'Object.assign(window, { __core: { createThread, postReply, createAnchor, mountPageList, mountAsks } });\n',
  );
  const built = spawnSync('bun', ['build', entry, '--target=browser'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr}`);
  return built.stdout;
}

/** Three threads, each with an exchange, and the list and asks mounted. */
const SEED = `(() => {
  const c = window.__core;
  const el = document.querySelector('${TAG}');
  const doc = el.client.ydoc;
  const alice = { id: 'known-a', name: 'Alice', kind: 'known', color: '#7a5cc4' };
  const agent = { id: 'agent-b', name: 'Bob', kind: 'agent', color: '#2e7dd7' };
  const put = (threadId, id) => {
    c.createThread(doc, { threadId, anchor: JSON.parse(JSON.stringify(c.createAnchor(document.getElementById(id)))), createdBy: alice, firstComment: { id: 'c0-' + threadId, text: 'Which pier does this leave from?' } });
    c.postReply(doc, threadId, { id: 'c1-' + threadId, author: agent, text: 'The north pier, from the first sailing on.' });
    c.postReply(doc, threadId, { id: 'c2-' + threadId, author: alice, text: 'Then the map on the next page is wrong.' });
  };
  put('t-top', 'top');
  put('t-bottom', 'bottom');
  put('t-ask', 'ask');
  c.postReply(doc, 't-ask', { id: 'c3-t-ask', author: agent, text: 'Which map should change?',
    review: { shape: 'decision', headline: 'Which map shows the winter piers?',
      detail: 'The timetable and the map disagree about where the winter sailings stop. One of them has to change, and the other pages follow whichever you pick.',
      options: [{ id: 'map', label: 'Change the map' }, { id: 'table', label: 'Change the table' }] } });
  c.mountPageList(el);
  c.mountAsks(el);
})()`;

const LOOK = `(() => {
  const sh = document.querySelector('${TAG}').shadowRoot;
  const box = (e) => {
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return [r.left, r.top, r.right, r.bottom].map(Math.round);
  };
  const pop = sh.querySelector('.thread-popover');
  return {
    win: [innerWidth, innerHeight],
    pop: box(pop),
    box: box(pop && pop.querySelector('.actions textarea')),
    send: box(pop && pop.querySelector('.actions .submit')),
  };
})()`;

async function drive(cdp: Cdp, dir: string, bundle: string): Promise<Reading> {
  const html = join(dir, 'page.html');
  writeFileSync(html, pageHtml(bundle));
  const reading: Reading = {};
  for (const [width, height] of SIZES) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= 1100,
    });
    for (const id of THREADS) {
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `file://${html}` });
      await loaded;
      await sleep(300);
      await cdp.evaluate(SEED);
      // The render the seed scheduled, then the rAF loop that places pins.
      await sleep(400);
      await cdp.evaluate(`(() => {
        const el = document.querySelector('${TAG}');
        el.togglePanel(true);
        el.shadowRoot.querySelector('.panel-threads [data-thread-id="${id}"]').click();
      })()`);
      await sleep(300);
      const look = (await cdp.evaluate(LOOK)) as Look;
      await sleep(500);
      look.popLater = ((await cdp.evaluate(LOOK)) as Look).pop;
      look.el = (await cdp.evaluate(`(() => {
        const r = document.getElementById(${JSON.stringify(id.slice(2))}).getBoundingClientRect();
        return [r.left, r.top, r.right, r.bottom].map(Math.round);
      })()`)) as Box;
      reading[`${width}x${height}:${id}`] = look;
    }
  }
  return reading;
}

const runId = `replybox${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-reply-box-'));
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
