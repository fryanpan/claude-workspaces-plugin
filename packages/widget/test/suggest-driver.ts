#!/usr/bin/env bun
/**
 * An agent's comment and suggested words on a page, end to end, in headless
 * Chromium against a real board server.
 *
 * The agent opens threads by the words a page shows, through the same route
 * `create_thread` calls. On a mock the board serves, the driver reads which
 * pins the frame drew, taps the suggestion's pin, and presses Accept: the
 * board must then hold a page edit and the suggestion must be resolved. A
 * second suggestion is rejected. On an attached app, a thread for one page
 * must pin there and a thread for another page must not.
 *
 * Spawned by `suggest-browser.test.ts`, which reads the JSON it prints.
 * `SUGGEST_SHOTS=<dir>` also writes screenshots at 1180x820 and 430x932.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  type Surface,
  buildWidget,
  frameSessions,
  frameSurface,
  poll,
  reload,
  sleep,
  tap,
} from './frame-driver-kit.ts';

export interface SuggestRun {
  /** Thread ids whose pins the mock's frame drew. */
  mockPins: string[];
  /** The suggestion block's words, as the popover showed them. */
  shown: { was: string | null; now: string | null; buttons: string[] };
  accepted: { edit: { before: string; after: string } | null; resolved: boolean; page: string };
  rejected: { resolved: boolean; edits: number; page: string };
  /** On the app's /calendar page: which of the two threads pinned. */
  appPins: string[];
  ids: { comment: string; suggestion: string; reject: string; here: string; elsewhere: string };
}

const TAG = 'claude-feedback-widget';
const SHADOW = `document.querySelector('${TAG}')?.shadowRoot`;
const PINS = `[...document.querySelectorAll('.cfw-pin')].filter((p) => !p.hidden).map((p) => p.dataset.threadId)`;
const pin = (id: string) => `document.querySelector('.cfw-pin[data-thread-id="${id}"]')`;
const SUGG = `${SHADOW}?.querySelector('.thread-popover .cw-sugg')`;

const page = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Harborlight</title>
<style>body{font:16px/1.5 system-ui;margin:0;padding:40px 60px}</style></head><body>${body}</body></html>`;

const step = (what: string): void => {
  process.stderr.write(`[suggest-driver] ${what}\n`);
};

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'suggest-'));
  const shots = process.env.SUGGEST_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let handle: ServerHandle | undefined;
  let dev: ReturnType<typeof Bun.serve> | undefined;
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      requireSignInToWrite: false,
    });
    const h = handle;
    const base = `http://127.0.0.1:${h.port}`;
    const post = async (path: string, payload: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const agent = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author: agent })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const byFind = async (docId: string, body: Record<string, unknown>) =>
      (
        (await post(`/workspaces/${ws}/docs/${docId}/threads/by_find`, {
          author: agent,
          ...body,
        })) as {
          thread: { id: string };
        }
      ).thread.id;

    const mockFile = join(dir, 'mock.html');
    writeFileSync(
      mockFile,
      page(
        '<h1 id="title">Harborlight events</h1>' +
          '<p id="lede">Join the Riverbend walk on Sunday.</p>' +
          '<p id="ferry">Saltmarsh ferry leaves at nine.</p>',
      ),
    );
    const mockId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'harborlight-mock',
          type: 'mockup',
          sourceUrl: mockFile,
        })
      ).docId,
    );
    await post(`/workspaces/${ws}/docs:attach`, { docId: mockId });
    const comment = await byFind(mockId, {
      text: 'Should this name the month?',
      find: 'Harborlight events',
    });
    const suggestion = await byFind(mockId, {
      text: 'Name the street?',
      find: 'Riverbend walk',
      suggest: { replacement: 'Riverbend Street walk' },
    });
    const reject = await byFind(mockId, {
      text: 'Earlier?',
      find: 'leaves at nine',
      suggest: { replacement: 'leaves at eight' },
    });

    dev = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) =>
        new Response(
          new URL(req.url).pathname === '/calendar'
            ? page('<h1 id="cal">Saltmarsh calendar</h1><p>Riverbend walk, Sunday.</p>')
            : page('<h1 id="cal">Harborlight home</h1>'),
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
    });
    const app = String(
      (
        await post(`/workspaces/${ws}/apps`, {
          docId: 'harborlight-app',
          origin: `http://127.0.0.1:${dev.port}/`,
        })
      ).docId,
    );
    const here = await byFind(app, {
      text: 'Which year?',
      find: 'Saltmarsh calendar',
      path: '/calendar',
    });
    const elsewhere = await byFind(app, {
      text: 'Not here',
      find: 'Saltmarsh calendar',
      path: '/elsewhere',
    });

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `suggest-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const sessions = await frameSessions(cdp);
    const size = (width: number, height: number) =>
      cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width <= 1100,
      });
    const shot = async (name: string) => {
      if (!shots) return;
      const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
      writeFileSync(join(shots, name), Buffer.from(png.data, 'base64'));
    };
    const mockUrl = `${base}/workspaces/${ws}/mockups/${mockId}`;
    const mock = frameSurface(cdp, sessions, "document.getElementById('lede')");
    const pinsOf = async (s: Surface, want: number) =>
      (await poll(`${want} pins`, async () => {
        const ids = (await s.eval(PINS)) as string[] | null;
        return ids && ids.length >= want ? ids : null;
      })) as string[];
    const quotes: Record<string, string> = {
      [comment]: 'Harborlight events',
      [suggestion]: 'Riverbend walk',
      [reject]: 'leaves at nine',
    };
    const open = async (id: string) => {
      // On a phone an open thread's sheet covers the other pins: close it
      // first, with the comment view's "‹ All comments" (or a bare popover's
      // ×). Wide, the thread sits in the view's column beside the page, and
      // the next pin's tap replaces it, so there is nothing to close.
      const closer = `[...(${SHADOW}?.querySelectorAll('[data-back], .thread-popover .close') ?? [])].find((e) => e.getBoundingClientRect().width)`;
      if (await mock.eval(`!!${closer}`)) {
        await tap(cdp, mock, closer, 'the way back to all comments');
        await poll('the popover closed', () =>
          mock.eval(`!${SHADOW}?.querySelector('.thread-popover')`).then((v) => v || null),
        );
      }
      // A pin drawn before the frame settles can move under the first tap: tap again.
      // The popover names no thread; it quotes the words its thread is anchored to.
      const words = JSON.stringify(quotes[id] ?? '');
      const up = `[...(${SHADOW}?.querySelectorAll('.thread-popover') ?? [])].some((p) => p.textContent.includes(${words}))`;
      for (let i = 0; i < 4 && !(await mock.eval(up)); i++) {
        await tap(cdp, mock, pin(id), `the pin of ${id}`);
        for (let j = 0; j < 20 && !(await mock.eval(up)); j++) await sleep(50);
      }
      await poll('its popover', () => mock.eval(up).then((v) => v || null));
    };

    await size(1180, 820);
    step('open the mock');
    await reload(cdp, mockUrl);
    const mockPins = await pinsOf(mock, 3);
    await open(comment);
    await shot('comment-1180.png');
    await open(suggestion);
    await poll('the suggestion block', () => mock.eval(`!!${SUGG}`).then((v) => v || null));
    await shot('suggestion-1180.png');
    const shown = (await mock.eval(`(() => { const b = ${SUGG}; return {
      was: b.querySelector('.was')?.textContent ?? null,
      now: b.querySelector('.now')?.textContent ?? null,
      buttons: [...b.querySelectorAll('button')].map((x) => x.textContent),
    }; })()`)) as SuggestRun['shown'];

    await size(430, 932);
    await reload(cdp, mockUrl);
    await pinsOf(mock, 3);
    await open(comment);
    await shot('comment-430.png');
    await open(suggestion);
    await poll('the suggestion block', () => mock.eval(`!!${SUGG}`).then((v) => v || null));
    await shot('suggestion-430.png');

    step('accept');
    await tap(cdp, mock, `${SUGG}?.querySelector('[data-accept]')`, 'Accept');
    const editThread = await poll(
      'a page edit on the board',
      () => h.docStore.listThreads(mockId).find((t) => t.comments[0]?.pageEdits) ?? null,
    );
    const edit = editThread.comments[0]?.pageEdits?.[0];
    const acceptedResolved = await poll('the suggestion resolved', () =>
      h.docStore.getThread(mockId, suggestion)?.status === 'resolved' ? true : null,
    ).catch(() => false);
    const accepted = {
      edit: edit ? { before: edit.before, after: edit.after } : null,
      resolved: acceptedResolved,
      page: String(await mock.eval(`document.getElementById('lede').textContent`)),
    };
    await shot('accepted-430.png');

    step('reject');
    await size(1180, 820);
    await reload(cdp, mockUrl);
    await pinsOf(mock, 2);
    await open(reject);
    await poll('the suggestion block', () => mock.eval(`!!${SUGG}`).then((v) => v || null));
    await tap(cdp, mock, `${SUGG}?.querySelector('[data-reject]')`, 'Reject');
    const rejectedResolved = await poll('the rejection resolved', () =>
      h.docStore.getThread(mockId, reject)?.status === 'resolved' ? true : null,
    ).catch(() => false);
    const rejected = {
      resolved: rejectedResolved,
      edits: h.docStore.listThreads(mockId).filter((t) => t.comments[0]?.pageEdits).length,
      page: String(await mock.eval(`document.getElementById('ferry').textContent`)),
    };

    step('open the app page');
    const appSurface = frameSurface(cdp, sessions, "document.getElementById('cal')");
    await reload(cdp, `${base}/workspaces/${ws}/apps/${app}/calendar`);
    const appPins = await pinsOf(appSurface, 1);
    await shot('app-1180.png');
    cdp.close();
    const run: SuggestRun = {
      mockPins,
      shown,
      accepted,
      rejected,
      appPins,
      ids: { comment, suggestion, reject, here, elsewhere },
    };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    dev?.stop(true);
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
