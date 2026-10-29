#!/usr/bin/env bun
/**
 * What a mock thread's popover draws for a comment written in markdown, read
 * in headless Chromium.
 *
 * Spawned by `comment-markdown-browser.test.ts`, which reads the JSON it
 * prints. The page loads the widget with `mockup-live.ts` through the script
 * tag a served mock carries (`data-doc-id`, `data-workspace-id`), so the
 * popover is decorated by whatever a real mock frame mounts, not by a call
 * this driver makes. Two threads: one whose comment holds a link, bold text
 * and a list, and one whose comment tries a `javascript:` link and a raw
 * `<img onerror>`.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was read off a running browser.
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

export interface Body {
  /** The popover opened at all — the positive control. */
  opened: boolean;
  links: Array<{ href: string; text: string; rel: string; target: string }>;
  strong: string[];
  li: string[];
  /** Elements the comment's text could have made if it were parsed as HTML. */
  injected: number;
  /** Set by the injected handler, if it ever ran. */
  pwned: boolean;
  text: string;
}

export type Reading = Record<'t-md' | 't-xss', Body>;

export const MD_TEXT =
  'Move the sign to [the Riverbend pier](https://example.com/riverbend?a=1&b=2), **before** spring:\n\n- north gate\n- south gate';
export const XSS_TEXT =
  '[x](javascript:alert(1)) <img src=x onerror="window.__pwned=true"> <script>window.__pwned=true</script>';

function pageHtml(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif}main{padding:24px}</style>
</head><body><main>
 <h1>Harborlight pier signs</h1>
 <p id="md">The sign stands at the gate.</p>
 <p id="xss">Saltmarsh ferry runs hourly.</p>
</main>
<${TAG} doc-id="mock-md" workspace-id="w-demo" user="Alice" server-url="ws://127.0.0.1:1"></${TAG}>
<script data-doc-id="mock-md" data-workspace-id="w-demo">${bundle}</script>
</body></html>`;
}

/** The widget, and the script a served mock loads beside it. */
function buildWidget(dir: string): string {
  const entry = join(dir, 'entry.ts');
  const src = (p: string) => JSON.stringify(join(import.meta.dirname, p));
  writeFileSync(
    entry,
    `import ${src('../src/widget.ts')};\n` +
      `import ${src('../src/mockup-live.ts')};\n` +
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

const SEED = `(() => {
  const c = window.__core;
  const el = document.querySelector('${TAG}');
  const doc = el.client.ydoc;
  const alice = { id: 'known-a', name: 'Alice', kind: 'known', color: '#7a5cc4' };
  const put = (threadId, id, text) => c.createThread(doc, { threadId,
    anchor: JSON.parse(JSON.stringify(c.createAnchor(document.getElementById(id)))),
    createdBy: alice, firstComment: { id: 'c0-' + threadId, text } });
  put('t-md', 'md', ${JSON.stringify(MD_TEXT)});
  put('t-xss', 'xss', ${JSON.stringify(XSS_TEXT)});
})()`;

const READ = `(() => {
  const sh = document.querySelector('${TAG}').shadowRoot;
  const body = sh.querySelector('.thread-popover .comment .body');
  const all = (s) => body ? [...body.querySelectorAll(s)] : [];
  return {
    opened: !!body,
    links: all('a').map((a) => ({ href: a.getAttribute('href'), text: a.textContent,
      rel: a.getAttribute('rel'), target: a.getAttribute('target') })),
    strong: all('strong').map((e) => e.textContent),
    li: all('li').map((e) => e.textContent),
    injected: all('img, script').length + document.querySelectorAll('body > img').length,
    pwned: window.__pwned === true,
    text: body ? body.textContent : '',
  };
})()`;

async function until(cdp: Cdp, expr: string, tries = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await cdp.evaluate(`!!(${expr})`)) return true;
    await sleep(50);
  }
  return false;
}

async function drive(cdp: Cdp, dir: string, bundle: string): Promise<Reading> {
  const html = join(dir, 'page.html');
  writeFileSync(html, pageHtml(bundle));
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1180,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `file://${html}` });
  await loaded;
  const panel = `document.querySelector('${TAG}').shadowRoot`;
  if (!(await until(cdp, `document.querySelector('${TAG}')?.client`))) {
    throw new Error('the widget never connected a doc');
  }
  await cdp.evaluate(SEED);
  const reading = {} as Reading;
  for (const id of ['t-md', 't-xss'] as const) {
    const row = `${panel}.querySelector('.panel-threads [data-thread-id="${id}"]')`;
    await cdp.evaluate(`document.querySelector('${TAG}').togglePanel(true)`);
    if (!(await until(cdp, row))) throw new Error(`no row for ${id} in the panel`);
    await cdp.evaluate(`${row}.click()`);
    await until(cdp, `${panel}.querySelector('.thread-popover .comment .body')`);
    // The handler an injected <img> would carry runs on its load error, a
    // task after insertion; give it the frames to have run.
    await cdp.evaluate('new Promise((r) => setTimeout(r, 200))');
    reading[id] = (await cdp.evaluate(READ)) as Body;
    await cdp.evaluate(`${panel}.querySelector('.thread-popover')?.remove()`);
  }
  return reading;
}

const runId = `commentmd${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-comment-md-'));
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
