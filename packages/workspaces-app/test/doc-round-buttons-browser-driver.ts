#!/usr/bin/env bun
/**
 * The round comment buttons on a markdown doc page, in headless Chromium
 * against a real server and the real doc bundle.
 *
 * The doc has a thread open (`?thread=`) and a `::scratch{block="…"}` line
 * that the board maps to an attached app, so a live app frame sits in the
 * prose. Read at 1180x820 and at 430x932:
 *
 *   - the comment button and the mic in the bottom-right corner, each on top
 *     where it is drawn (nothing covers it);
 *   - the end of the doc scrolled into view, clear of the buttons;
 *   - the new-comment composer opened off a selection, its Post button
 *     reachable with the buttons on the page;
 *   - the app frame's own page, which carries no widget (`cw-embed=1`);
 *   - the same doc opened with `?cw-embed=1`, which mounts no widget.
 *
 * Spawned by `doc-round-buttons-browser.test.ts`, which reads the JSON it
 * prints. `DOC_BUTTONS_SHOTS=<dir>` also writes a screenshot per width.
 *
 * audit: no-text — every value returned comes from the running page.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import {
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
  stopBrowser,
} from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  extraChromeArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import type {
  ButtonRead,
  ButtonsView,
  DocButtonsReading,
  Rect,
} from './doc-round-buttons-reading.ts';

const APP_TEXT = 'Riverbend ferry map';
const PHRASE = 'the Saltmarsh slipway';
const LAST = 'Harborlight closing note.';
const FILL = Array.from(
  { length: 6 },
  (_, i) =>
    `Paragraph ${i + 1}: the Riverbend ferry leaves the north quay at dawn and returns before the evening freight.`,
).join('\n\n');
const DOC = `# Harborlight ferry\n\n${FILL}\n\nThe map below shows ${PHRASE} and the tide.\n\n::scratch{block="ferry-map"}\n\n${FILL}\n\n${LAST}\n`;

const step = (what: string): void => {
  process.stderr.write(`[doc-buttons-driver] ${what}\n`);
};

async function until<T>(what: string, read: () => Promise<T | null>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(100);
  }
  throw new Error(`never happened: ${what}`);
}

let browser: { proc: ChildProcess; profile: string } | undefined;
let fixtureApp: ReturnType<typeof Bun.serve> | undefined;

interface FrameNode {
  frame: { id: string; url: string };
  childFrames?: FrameNode[];
}

/** For every child frame: its address, whether it holds a widget, its text. */
async function childFrames(
  cdp: Cdp,
): Promise<Array<{ url: string; widget: boolean; text: string }>> {
  const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: FrameNode };
  const nodes: FrameNode[] = [];
  const walk = (n: FrameNode): void => {
    for (const c of n.childFrames ?? []) {
      nodes.push(c);
      walk(c);
    }
  };
  walk(frameTree);
  const out: Array<{ url: string; widget: boolean; text: string }> = [];
  for (const n of nodes) {
    try {
      const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', {
        frameId: n.frame.id,
      })) as { executionContextId: number };
      const r = (await cdp.send('Runtime.evaluate', {
        expression: `({ widget: !!document.querySelector('claude-feedback-widget'),
                         text: document.body ? document.body.innerText : '' })`,
        contextId: executionContextId,
        returnByValue: true,
      })) as { result?: { value?: { widget: boolean; text: string } } };
      out.push({ url: n.frame.url, ...(r.result?.value ?? { widget: false, text: '' }) });
    } catch {
      out.push({ url: n.frame.url, widget: false, text: '' });
    }
  }
  return out;
}

/** One corner button: its box, and whether the page's own hit test lands on it. */
const BUTTON_READ = `(() => {
  const host = document.querySelector('claude-feedback-widget');
  const root = host && host.shadowRoot;
  const read = (sel) => {
    const b = root && root.querySelector(sel);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    if (r.width === 0 || getComputedStyle(b).display === 'none' || getComputedStyle(b).visibility === 'hidden') return null;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const inner = top === host ? root.elementFromPoint(x, y) : null;
    return { rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
             onTop: !!inner && (inner === b || b.contains(inner)) };
  };
  return { comment: read('.fab'), mic: read('.fab-mic'),
           vw: document.documentElement.clientWidth, vh: innerHeight };
})()`;

/** Scroll every scroller to its end and read the last block's box. */
const END_READ = `(() => {
  const last = [...document.querySelectorAll('#editor p')].find((p) => p.textContent.includes(${JSON.stringify(LAST)}));
  if (!last) return null;
  last.scrollIntoView({ block: 'end' });
  for (let el = last.parentElement; el; el = el.parentElement) el.scrollTop = el.scrollHeight;
  document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
  const r = last.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
})()`;

/** Select the commented phrase, as a reader's drag would. */
const SELECT_PHRASE = `(() => {
  const pm = document.querySelector('#editor .ProseMirror');
  const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.data.indexOf(${JSON.stringify(PHRASE)});
    if (i < 0) continue;
    n.parentElement.scrollIntoView({ block: 'center' });
    pm.focus();
    const r = document.createRange();
    r.setStart(n, i);
    r.setEnd(n, i + ${JSON.stringify(PHRASE)}.length);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    return true;
  }
  return null;
})()`;

/** The open composer's Post button, and whether a tap at its centre reaches it. */
const COMPOSER_READ = `(() => {
  const box = document.getElementById('composer');
  const b = document.getElementById('composer-submit');
  if (!box || box.classList.contains('hidden') || !b) return null;
  const r = b.getBoundingClientRect();
  // Still sliding in: the sheet starts below the screen.
  if (r.width === 0 || r.bottom > innerHeight) return null;
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
           onTop: !!top && (top === b || b.contains(top)) };
})()`;

/** Open the new-comment composer off the phrase, and read its Post button
 *  once it has stopped moving, with the corner as it stands then. */
async function readComposer(cdp: Cdp): Promise<ButtonsView['composer']> {
  await until('the phrase selected', async () => cdp.evaluate(SELECT_PHRASE));
  await until('the comment pill', async () =>
    cdp.evaluate(
      `(() => { const p = document.getElementById('comment-pill');
                if (!p || p.classList.contains('hidden')) return null; p.click(); return true; })()`,
    ),
  );
  let last = '';
  const post = (await until('the composer at rest', async () => {
    const v = (await cdp.evaluate(COMPOSER_READ)) as ButtonRead | null;
    const key = JSON.stringify(v);
    const still = v !== null && key === last;
    last = key;
    return still ? v : null;
  })) as ButtonRead;
  const corner = (await cdp.evaluate(BUTTON_READ)) as ButtonsView['buttons'];
  return { post, corner };
}

async function open(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  await until('the doc body', async () =>
    cdp.evaluate(
      `(document.querySelector('#editor .ProseMirror')?.textContent ?? '').includes(${JSON.stringify(LAST)}) || null`,
    ),
  );
}

async function readWidth(
  cdp: Cdp,
  url: string,
  width: number,
  height: number,
  threadId: string,
): Promise<ButtonsView> {
  const touch = width <= 1100;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: touch,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 5 });
  await open(cdp, url);
  const threadOpen =
    (await until('the thread open', async () =>
      cdp.evaluate(
        `document.querySelector('[data-thread-id=${JSON.stringify(threadId)}].active') ? true : null`,
      ),
    ).catch(() => false)) === true;
  // The app frame in view, as it was when the buttons went missing.
  await until('the app frame', async () =>
    cdp.evaluate(
      `(() => { const f = document.querySelector('#editor iframe[data-embed-block="ferry-map"]');
                if (!f) return null; f.scrollIntoView({ block: 'center' }); return true; })()`,
    ),
  );
  const frameRendered = await until(
    'the app page rendered',
    async () => (await childFrames(cdp)).some((f) => f.text.includes(APP_TEXT)) || null,
  ).catch(() => false);
  const buttons = (await until('the corner buttons', async () => {
    const v = (await cdp.evaluate(BUTTON_READ)) as ButtonsView['buttons'];
    return v.comment && v.mic ? v : null;
  }).catch(async () => cdp.evaluate(BUTTON_READ))) as ButtonsView['buttons'];
  const frames = await childFrames(cdp);
  const shots = process.env.DOC_BUTTONS_SHOTS;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
      data: string;
    };
    writeFileSync(join(shots, `doc-buttons-${width}x${height}.png`), Buffer.from(data, 'base64'));
  }
  const end = (await cdp.evaluate(END_READ)) as Rect | null;
  const afterEnd = (await cdp.evaluate(BUTTON_READ)) as ButtonsView['buttons'];
  const composer = await readComposer(cdp);
  if (shots) {
    const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
      data: string;
    };
    writeFileSync(
      join(shots, `doc-buttons-${width}x${height}-composer.png`),
      Buffer.from(data, 'base64'),
    );
  }
  return {
    width,
    height,
    threadOpen,
    frameRendered,
    buttons,
    end,
    buttonsAtEnd: afterEnd,
    composer,
    framesWithWidget: frames.filter((f) => f.widget).map((f) => f.url),
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'doc-buttons-'));
  let handle: ServerHandle | undefined;
  try {
    step('build the doc bundle');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);

    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const docPath = join(dir, 'ferry.md');
    writeFileSync(docPath, DOC);
    fixtureApp = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(
          `<!doctype html><title>Riverbend</title><body style="height:320px"><h1>${APP_TEXT}</h1></body>`,
          { headers: { 'content-type': 'text/html' } },
        ),
    });
    handle = createServer({
      port: 0,
      dataDir,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const port = handle.port;
    const base = `http://127.0.0.1:${port}`;
    const post = async (path: string, payload: unknown, method = 'POST') => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { host: `localhost:${port}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight' })) as { workspace: { id: string } }
    ).workspace.id;
    const docId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'ferry',
          type: 'markdown',
          sourceUrl: docPath,
        })
      ).docId,
    );
    await post(`/workspaces/${ws}/docs:attach`, { docId });
    const appDocId = String(
      (
        await post(`/workspaces/${ws}/apps`, {
          docId: 'riverbend',
          origin: `http://127.0.0.1:${fixtureApp.port}/`,
          title: 'Riverbend',
        })
      ).docId,
    );
    await post(
      `/workspaces/${ws}/embeds`,
      { embeds: { scratch: { appDocId, pathTemplate: '{mount}/embed/{block}/' } } },
      'PUT',
    );
    // A thread on the phrase just above the frame, anchored as the editor anchors one.
    await fetch(`${base}/workspaces/${ws}/docs/${docId}`);
    const ydoc = await until(
      'the doc in memory',
      async () => handle?.docStore.get(docId)?.ydoc ?? null,
    );
    const walk = prose.walkProse(prose.getProseFragment(ydoc));
    const at = walk.plainText.indexOf(PHRASE);
    const seg = walk.segments.find((g) => at >= g.docOffset && at < g.docOffset + g.length);
    if (!seg) throw new Error(`no text segment holds "${PHRASE}"`);
    const rel = (i: number) =>
      Array.from(
        Y.encodeRelativePosition(
          Y.createRelativePositionFromTypeIndex(seg.node, i - seg.docOffset),
        ),
      );
    const made = await post(`/workspaces/${ws}/docs/${docId}/threads`, {
      author: { id: 'known-alice', name: 'Alice', color: '#3366cc' },
      text: 'Is the slipway open at low tide?',
      anchor: {
        kind: 'text-range',
        startRel: rel(at),
        endRel: rel(at + PHRASE.length),
        snippet: { text: PHRASE },
      },
    });
    const threadId =
      (made.thread as { id?: string } | undefined)?.id ?? (made.id as string | undefined);
    if (!threadId) throw new Error(`no thread id: ${JSON.stringify(made)}`);

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) =>
        chromeLaunchArgs({ width: 1180, height: 820 }, profile, [
          ...extraChromeArgs(),
          // Every frame in one renderer, so the frame tree reaches them all.
          '--disable-site-isolation-trials',
          '--disable-features=IsolateOrigins,site-per-process',
        ]),
      STARTUP_TIMEOUT_MS,
      `doc-buttons-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Bob'); } catch {}`,
    });
    const docPage = `${base}/workspaces/${ws}/docs/${docId}`;
    const views: ButtonsView[] = [];
    for (const [w, h] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      step(`read the corner at ${w}x${h}`);
      views.push(await readWidth(cdp, `${docPage}?thread=${threadId}`, w, h, threadId));
    }
    step('open the doc as an embed');
    await open(cdp, `${docPage}?cw-embed=1`);
    const embedPage = Boolean(
      await cdp.evaluate(`!!document.querySelector('claude-feedback-widget')`),
    );
    cdp.close();
    const reading: DocButtonsReading = { views, embedPageHasWidget: embedPage };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    fixtureApp?.stop(true);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 170s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 170_000).unref();
await main();
process.exit(0);
