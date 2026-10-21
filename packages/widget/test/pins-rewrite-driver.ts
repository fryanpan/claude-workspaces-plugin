#!/usr/bin/env bun
/**
 * Comment pins on a mock whose author rewrites a few words of each commented
 * element every round, driven in headless Chromium.
 *
 * Spawned by `pins-rewrite.test.ts`, which reads the JSON it prints. A report
 * is commented on in its heading, a paragraph and a table cell, and then
 * revised three times. Each round adds a section and a row above the
 * commented elements and changes a few of their words, so by the third round
 * none of them says much of what it said when the comment was made.
 *
 * The server is played here, by a Y.Doc in this process: the page loads each
 * round with the threads that doc holds, and every anchor the page reports
 * through `reanchor` with `refresh: true` is applied to it with the server's
 * own `refreshAnchor`. A second run applies none, which is what the page
 * would get from a server that kept only the first anchor. A third deletes
 * the commented paragraph in its second round.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was measured in a running browser.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import {
  type Browser,
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
} from '../../../scripts/headless-chrome.ts';
import { chromeLaunchArgs, profilesOfRun, resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';
import { refreshAnchor } from '../../core/src/anchor/refresh.ts';
import { createThread, listThreads } from '../../core/src/schema.ts';
import type { Anchor, ElementAnchor } from '../../core/src/types.ts';
import { ROUNDS } from './pins-rewrite-rounds.ts';

const TAG = 'claude-feedback-widget';

/** [left, top, right, bottom], rounded. */
export type Box = [number, number, number, number];

export interface Look {
  /** Each thread's pin: painted at all, and where its tip is. */
  pins: Record<string, { shown: boolean; tip: [number, number] } | undefined>;
  /** Each commented element's box, found by its words this round; null with none. */
  el: Record<string, Box | null>;
  /** The threads the panel lists under "No spot on the page". */
  noSpot: string[];
  rows: number;
}

export interface Reading {
  /** One look per round, for each run. */
  runs: Record<'refreshed' | 'kept' | 'deleted', Look[]>;
  /** How many anchors the page reported in each round of the refreshed run. */
  reported: number[];
}

const TAGS = { 't-heading': 'h3', 't-para': 'p', 't-cell': 'td' } as const;

function pageHtml(bundle: string, round: number, deleted: boolean): string {
  const say = ROUNDS[round] ?? ROUNDS[0];
  // Each round adds a section above the commented ones and a row above the cell.
  const added = Array.from(
    { length: round },
    (_, i) => `<h3>Harborlight low water by month</h3><p>Falls fastest in autumn ${i}.</p>`,
  ).join('');
  const rows = Array.from(
    { length: round },
    (_, i) => `<tr><td>April ${i}</td><td>3.5 m at noon</td></tr>`,
  ).join('');
  const para = deleted ? '' : `<p>${say['t-para']}</p>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
 body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#1d1d1b}
 main{max-width:720px;padding:24px 32px}
 td{padding:4px 16px;border-bottom:1px solid #ddd}
</style>
<script>
// The page's server: every write is recorded and answered, none sent.
window.__posts = [];
window.fetch = async (url, init) => {
  if (init && init.method === 'POST') window.__posts.push({ url: String(url), body: String(init.body) });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
</script></head>
<body>
<main>
 <h1>Saltmarsh tide report</h1>
 <p>Readings from the Riverbend gauge.</p>
 ${added}
 <h3>${say['t-heading']}</h3>
 ${para}
 <table><tbody>${rows}<tr><td>May</td><td>3.8 m at noon</td></tr><tr><td>June</td><td>${say['t-cell']}</td></tr></tbody></table>
</main>
<${TAG} doc-id="pins-rewrite" workspace-id="w-demo" user="Alice" server-url="ws://127.0.0.1:1"></${TAG}>
<script>${bundle}</script>
</body></html>`;
}

function buildWidget(dir: string): string {
  const entry = join(dir, 'entry.ts');
  const src = (p: string) => JSON.stringify(join(import.meta.dirname, p));
  writeFileSync(
    entry,
    `import ${src('../src/widget.ts')};\n` +
      `import { mountPageList } from ${src('../src/widget-page-list.ts')};\n` +
      `import { createThread } from ${src('../../core/src/schema.ts')};\n` +
      `import { createAnchor } from ${src('../../core/src/anchor/element.ts')};\n` +
      'Object.assign(window, { __core: { createThread, createAnchor } });\n' +
      // What `mic.js` and `mockup-live.js` do on every page that has a widget.
      `mountPageList(document.querySelector('${TAG}'));\n`,
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

const look = (round: number) => `(() => {
  const find = ${FIND};
  const say = ${JSON.stringify(ROUNDS[round])};
  const tags = ${JSON.stringify(TAGS)};
  const pins = {};
  for (const p of document.querySelectorAll('.cfw-pin')) {
    const r = p.getBoundingClientRect();
    pins[p.dataset.threadId] = {
      shown: getComputedStyle(p).display !== 'none' && r.width > 0,
      tip: [Math.round(r.left + 22), Math.round(r.top + 33)],
    };
  }
  const el = {};
  for (const [id, words] of Object.entries(say)) {
    const e = find(tags[id], words);
    const r = e && e.getBoundingClientRect();
    el[id] = r && (r.width || r.height) ? [r.left, r.top, r.right, r.bottom].map(Math.round) : null;
  }
  const shadow = document.querySelector('${TAG}').shadowRoot;
  const noSpot = [...shadow.querySelectorAll('[data-section=nospot] [data-thread-id]')].map((r) => r.dataset.threadId);
  return { pins, el, noSpot, rows: document.querySelectorAll('tr').length };
})()`;

interface Post {
  url: string;
  body: string;
}

async function run(
  cdp: Cdp,
  dir: string,
  bundle: string,
  opts: { apply: boolean; deleteAt?: number },
): Promise<{ looks: Look[]; reported: number[] }> {
  const server = new Y.Doc();
  const looks: Look[] = [];
  const reported: number[] = [];
  for (let round = 0; round < ROUNDS.length; round++) {
    const deleted = opts.deleteAt !== undefined && round >= opts.deleteAt;
    const html = join(dir, `round-${round}.html`);
    writeFileSync(html, pageHtml(bundle, round, deleted));
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `file://${html}` });
    await loaded;
    await sleep(300);
    if (round === 0) {
      // The anchors are made on the first round, as a reader's taps make them.
      const made = (await cdp.evaluate(`(() => {
        const find = ${FIND};
        const out = {};
        for (const [id, words] of Object.entries(${JSON.stringify(ROUNDS[0])})) {
          out[id] = JSON.parse(JSON.stringify(window.__core.createAnchor(find(${JSON.stringify(TAGS)}[id], words))));
        }
        return out;
      })()`)) as Record<string, Anchor>;
      const who = { id: 'known-r', name: 'Alice', kind: 'known' as const, color: '#7a5cc4' };
      for (const [threadId, anchor] of Object.entries(made)) {
        createThread(server, {
          threadId,
          anchor,
          createdBy: who,
          firstComment: { id: `c-${threadId}`, text: `Note on ${threadId}` },
        });
      }
    }
    // The page opens with the threads the server holds, through JSON.
    const held = Object.fromEntries(
      listThreads(server).map((t) => [t.id, JSON.parse(JSON.stringify(t.anchor))]),
    );
    await cdp.evaluate(`((anchors) => {
      const doc = document.querySelector('${TAG}').client.ydoc;
      const who = { id: 'known-r', name: 'Alice', kind: 'known', color: '#7a5cc4' };
      for (const [threadId, anchor] of Object.entries(anchors)) {
        window.__core.createThread(doc, { threadId, anchor, createdBy: who, firstComment: { id: 'c-' + threadId, text: 'Note on ' + threadId } });
      }
    })(${JSON.stringify(held)})`);
    // Two frames for the render, then the rAF loop that places pins.
    await sleep(500);
    looks.push((await cdp.evaluate(look(round))) as Look);
    const posts = (await cdp.evaluate('window.__posts')) as Post[];
    const refreshes = posts.filter((p) => p.url.endsWith('/reanchor'));
    reported.push(refreshes.length);
    if (!opts.apply) continue;
    for (const p of refreshes) {
      const id = decodeURIComponent(p.url.split('/threads/')[1]?.split('/')[0] ?? '');
      const body = JSON.parse(p.body) as { anchor: ElementAnchor; refresh?: boolean };
      if (body.refresh) refreshAnchor(server, id, body.anchor);
    }
  }
  return { looks, reported };
}

const runId = `pinsrw${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-pins-rewrite-'));
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
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const refreshed = await run(cdp, dir, bundle, { apply: true });
  const kept = await run(cdp, dir, bundle, { apply: false });
  const deleted = await run(cdp, dir, bundle, { apply: true, deleteAt: 2 });
  cdp.close();
  const reading: Reading = {
    runs: { refreshed: refreshed.looks, kept: kept.looks, deleted: deleted.looks },
    reported: refreshed.reported,
  };
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
