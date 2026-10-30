#!/usr/bin/env bun
/**
 * A mock's comment view counts only open threads, in headless Chromium
 * against a real board server at 1180x820.
 *
 * The mock is one page. Alice leaves four threads on it: one stays open, one
 * is resolved where its element still stands, and two are resolved on
 * elements a later round of the mock took away. The reader opens the mock
 * through the board's mock route, then loads it again, so every thread they
 * have not opened is new to them. The driver reads the view's count, its New
 * list and its page chip. Then, with the page open, the open thread is
 * resolved and a resolved one reopened over REST, and the driver reads the
 * count after each without a reload.
 *
 * Spawned by `mock-open-count-browser.test.ts`, which reads the JSON it prints.
 */
// audit: no-text
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, launchChrome, pageSocketUrl, stopBrowser } from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import {
  Q,
  SHADOW,
  frameSessions,
  frameSurface,
  navigate,
  pageSurface,
  poll,
  step,
  tap,
} from './draft-reload-page.ts';
import { buildWidget } from './frame-driver-kit.ts';

/** What the view shows at one moment. */
export interface Shown {
  /** The words beside the view's title, "N open on M page(s)", or "". */
  sub: string;
  /** The thread ids under New. */
  fresh: string[];
  /** Every thread id the view lists outside its Resolved group. */
  listed: string[];
  /** The page chips' counts, "N open". */
  chips: string[];
}

export interface Reading {
  ids: { open: string; resolvedHere: string; resolvedGone: string[] };
  /** On the second load, before anything changes. */
  loaded: Shown;
  /** After the open thread is resolved elsewhere, with the page still open. */
  afterResolve: Shown & { ms: number; reloaded: boolean };
  /** After the resolved thread whose element stands is reopened elsewhere. */
  afterReopen: Shown & { ms: number; reloaded: boolean };
}

const mockPage = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harborlight Ferries</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif} section{padding:20px 24px}</style>
</head><body>
<h1 id="title">Harborlight Ferries</h1>
<section><h2 id="seats">Choose a seat</h2><button id="pay">Pay 18.40</button></section>
</body></html>`;

/** An element anchor by id, as the widget makes on the mock's one page. */
const anchorOn = (mockUrl: string, id: string, tag: string, text: string) => ({
  kind: 'element',
  fingerprint: { id, tag, stableAttrs: {}, classes: [], text, path: '', dataAttrs: {} },
  snippet: { text },
  context: { url: `${mockUrl}?cw-frame=1` },
});

const SHOWN = `(() => {
  const s = ${SHADOW};
  const ids = (sel) => [...(s?.querySelectorAll(sel) ?? [])].map((t) => t.dataset.threadId);
  return {
    sub: s?.querySelector('.cw-sub')?.textContent ?? '',
    fresh: ids('[data-section=new] .thread'),
    listed: ids('.panel-threads [data-section]:not([data-section=resolved]) .thread'),
    chips: [...(s?.querySelectorAll('.cw-pchip .n') ?? [])].map((n) => n.textContent),
  };
})()`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mock-open-count-'));
  let handle: ServerHandle | undefined;
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      requireSignInToWrite: false,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, payload: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const agent = { id: 'agent-harborlight', name: 'Harborlight agent', kind: 'agent' };
    const alice = { id: 'u-alice', name: 'Alice', kind: 'known', color: '#1a7f37' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author: agent })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const file = join(dir, 'ferry.html');
    writeFileSync(file, mockPage);
    const docId = String(
      (await post(`/workspaces/${ws}/docs`, { docId: 'ferry', type: 'mockup', sourceUrl: file }))
        .docId,
    );
    await post(`/workspaces/${ws}/docs:attach`, { docId });
    const mockPath = `/workspaces/${ws}/mockups/${docId}`;
    const threads = `/workspaces/${ws}/docs/${docId}/threads`;
    const thread = async (id: string, tag: string, text: string, said: string) =>
      (
        (await post(threads, {
          author: alice,
          text: said,
          anchor: anchorOn(mockPath, id, tag, text),
        })) as { thread: { id: string } }
      ).thread.id;
    const ids: Reading['ids'] = {
      open: await thread('seats', 'H2', 'Choose a seat', 'Which side gets sun?'),
      resolvedHere: await thread('pay', 'BUTTON', 'Pay 18.40', 'Show the bike fee first.'),
      resolvedGone: [
        await thread('bikes', 'H2', 'Bike spaces', 'How many bikes fit?'),
        await thread('fees', 'P', 'Saltmarsh port fee', 'Is this fee per person?'),
      ],
    };
    for (const id of [ids.resolvedHere, ...ids.resolvedGone]) {
      await post(`${threads}/${id}/resolve`, { author: agent });
    }

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `mock-open-count-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1180,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const sessions = await frameSessions(cdp);
    const frame = frameSurface(cdp, sessions);
    const top = pageSurface(cdp);

    step('open the mock once, so the next load is not a first visit');
    await navigate(cdp, `${base}${mockPath}`);
    await poll('the widget drew its pins', () =>
      frame.eval(`document.querySelectorAll('.cfw-pin').length`).then((n) => (n ? true : null)),
    );
    step('open it again and the Comments view');
    await navigate(cdp, `${base}${mockPath}`);
    await poll('the widget drew its pins again', () =>
      frame.eval(`document.querySelectorAll('.cfw-pin').length`).then((n) => (n ? true : null)),
    );
    await frame.eval('(window.__cwBefore = 1)');
    await tap(cdp, top, `document.querySelector('[data-cw-comments]')`, 'Comments');
    await poll('the view opened', () => frame.eval(`${Q('.panel.open')} ? true : null`));
    const read = async () => (await frame.eval(SHOWN)) as Shown;
    const loaded = await poll('the view listed a thread', async () => {
      const s = await read();
      return s.listed.length ? s : null;
    });

    /** Change one thread over REST and time the view's count changing. */
    const change = async (verb: 'resolve' | 'reopen', id: string, from: string) => {
      const t0 = performance.now();
      await post(`${threads}/${id}/${verb}`, { author: agent });
      const s = await poll(`the count after ${verb}`, async () => {
        const got = await read();
        return got.sub !== from ? got : null;
      }).catch(read);
      return {
        ...s,
        ms: Math.round(performance.now() - t0),
        reloaded: (await frame.eval('window.__cwBefore === undefined')) === true,
      };
    };
    step('resolve the open thread elsewhere');
    const afterResolve = await change('resolve', ids.open, loaded.sub);
    step('reopen the resolved thread whose element stands');
    const afterReopen = await change('reopen', ids.resolvedHere, afterResolve.sub);
    cdp.close();
    process.stdout.write(
      `\n${JSON.stringify({ ids, loaded, afterResolve, afterReopen } satisfies Reading)}\n`,
    );
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 150s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 150_000).unref();
await main();
process.exit(0);
