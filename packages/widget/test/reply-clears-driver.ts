#!/usr/bin/env bun
/**
 * A reply sent from a mock's comment view, in headless Chromium against a
 * real board server, at 1180x820 and 430x932.
 *
 * Bryan, on a mock: "when I type a reply, and then hit enter on this page The
 * reply text stays and also appears above in the thread." The server shows
 * the reply to every open page as it stores it, so the page's own copy of the
 * reply can arrive before the answer to its POST. That arrival redraws the
 * comment view, and the redraw carried the reply box's words into the new
 * popover; the popover the send then closed was the old one, already gone.
 *
 * So the driver builds that order every time: it holds each reply POST's
 * response (CDP `Fetch`, at the response stage, after the server has stored
 * the comment) until the reply shows in the open thread, then lets it go.
 *
 * Three sends per width, each read for the reply box's words and for how
 * many times the reply was stored and shown:
 *  - `enter`: the Book pin opens its thread in the view; type, press Enter.
 *  - `button`: the same thread, still open; type, tap Reply.
 *  - `view`: from Timetable, tap Comments in the board's bar, tap the Pay
 *    thread in the list (the page goes to Pay); type, press Enter.
 *
 * Spawned by `reply-clears-browser.test.ts`, which reads the JSON it prints.
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
  SHADOW,
  type Surface,
  frameSessions,
  frameSurface,
  navigate,
  pageSurface,
  poll,
  step,
  tap,
} from './draft-reload-page.ts';
import { buildWidget } from './frame-driver-kit.ts';

export interface SendReading {
  /** What the reply box held once the send had finished. */
  box: string | null;
  /** How many comments in the open thread read as the reply. */
  shown: number;
  /** How many the server stored. */
  stored: number;
  /** Whether the reply showed in the thread before its POST was answered —
   *  the order under test. */
  echoFirst: boolean;
}

export interface Reading {
  runs: Record<string, Record<'enter' | 'button' | 'view', SendReading>>;
}

const REPLIES = {
  enter: 'Riverbend side, by the window.',
  button: 'Saltmarsh side has the shade.',
  view: 'Harborlight card fee is shown first now.',
} as const;

const mockPage = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harborlight Ferries booking</title>
<style>
 body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1d1d1b}
 nav{display:flex;gap:4px;padding:8px 16px;border-bottom:1px solid #e5e7eb}
 nav a{padding:10px 14px;color:#0b4f6c;text-decoration:none}
 section{padding:20px 24px 600px}
</style></head>
<body>
<nav><a href="#timetable">Timetable</a><a href="#book">Book</a><a href="#pay">Pay</a></nav>
<h1 id="title">Harborlight Ferries</h1>
<section data-pg="timetable"><h2 id="tt-row">07:40 Saltmarsh to Riverbend</h2></section>
<section data-pg="book"><h2 id="bk-seats">Choose a seat</h2></section>
<section data-pg="pay"><button id="pay-btn">Pay 18.40</button></section>
<script>
 const show = () => {
   const p = location.hash.slice(1) || 'timetable';
   for (const s of document.querySelectorAll('section')) s.hidden = s.dataset.pg !== p;
 };
 addEventListener('hashchange', show);
 show();
</script>
</body></html>`;

const anchorOn = (mockUrl: string, page: string, id: string, tag: string, text: string) => ({
  kind: 'element',
  fingerprint: { id, tag, stableAttrs: {}, classes: [], text, path: '', dataAttrs: {} },
  snippet: { text },
  context: { url: `${mockUrl}?cw-frame=1#${page}` },
});

const BOX = `${SHADOW}?.querySelector('.thread.active .thread-popover textarea')`;
const shownExpr = (text: string) =>
  `[...(${SHADOW}?.querySelectorAll('.thread-popover .comments .comment .body') ?? [])].filter((b) => b.textContent === ${JSON.stringify(text)}).length`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'reply-clears-'));
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

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `reply-clears-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const sessions = await frameSessions(cdp);
    const frame = frameSurface(cdp, sessions);
    const top = pageSurface(cdp);

    // Hold every reply POST's answer until the reply shows in the thread.
    let holding: { text: string; echoFirst: boolean | null } = { text: '', echoFirst: null };
    cdp.on('Fetch.requestPaused', (p, sessionId) => {
      const requestId = p.requestId as string;
      const method = (p.request as { method?: string } | undefined)?.method;
      void (async () => {
        if (method === 'POST' && holding.text) {
          const seen = await poll('the reply shown before its answer', () =>
            frame.eval(shownExpr(holding.text)).then((n) => (Number(n) > 0 ? true : null)),
          ).catch(() => false);
          holding.echoFirst = seen;
        }
        await cdp.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
      })();
    });
    const intercept = async (): Promise<void> => {
      const patterns = [{ urlPattern: '*/comments*', requestStage: 'Response' }];
      await cdp.send('Fetch.enable', { patterns });
      for (const s of [...sessions])
        await cdp.send('Fetch.enable', { patterns }, s).catch(() => {});
    };

    const comments = async (docId: string, threadId: string): Promise<string[]> => {
      const res = await fetch(`${base}/workspaces/${ws}/docs/${docId}/threads`);
      const body = (await res.json()) as
        | { threads?: Array<{ id: string; comments: Array<{ text: string }> }> }
        | Array<{ id: string; comments: Array<{ text: string }> }>;
      const list = Array.isArray(body) ? body : (body.threads ?? []);
      return list.find((t) => t.id === threadId)?.comments.map((c) => c.text) ?? [];
    };

    /** Type `text` into the open thread's reply box and send it with `how`. */
    const send = async (
      s: Surface,
      docId: string,
      threadId: string,
      text: string,
      how: 'enter' | 'button',
    ): Promise<SendReading> => {
      await tap(cdp, s, BOX, 'the reply box');
      await poll('the reply box focused', () =>
        s.eval(`${SHADOW}?.activeElement === ${BOX} ? true : null`),
      );
      // Each send starts from an empty box, so one send's leftover words
      // (the bug) are read on that send and do not spill into the next.
      await s.eval(`(() => { const b = ${BOX}; if (b) b.value = ''; return true; })()`);
      await cdp.send('Input.insertText', { text });
      await poll('the box holds the words', () =>
        s.eval(`${BOX}?.value`).then((v) => (v === text ? true : null)),
      );
      holding = { text, echoFirst: null };
      if (how === 'enter') {
        const k = {
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        };
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...k });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
      } else {
        await tap(
          cdp,
          s,
          `${SHADOW}?.querySelector('.thread.active .thread-popover .submit')`,
          'Reply',
        );
      }
      await poll('the server stored the reply', async () =>
        (await comments(docId, threadId)).includes(text) ? true : null,
      );
      await poll('the POST answered', () => (holding.echoFirst === null ? null : true));
      // The send's own close runs once its fetch resolves, after the answer
      // is let go: wait for the box to empty, and read what it holds if it
      // never does.
      await poll(
        'the box emptied',
        () => s.eval(`${BOX} && ${BOX}.value === '' ? true : null`),
        60,
      ).catch(() => null);
      await s.eval(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
      );
      const box = (await s.eval(`${BOX}?.value ?? null`)) as string | null;
      const stored = (await comments(docId, threadId)).filter((c) => c === text).length;
      return {
        box,
        shown: Number(await s.eval(shownExpr(text))),
        stored,
        echoFirst: holding.echoFirst === true,
      };
    };

    const runs: Reading['runs'] = {};
    for (const [width, height, mobile] of [
      [1180, 820, false],
      [430, 932, true],
    ] as const) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
      });
      const file = join(dir, `ferry-${width}.html`);
      writeFileSync(file, mockPage);
      const docId = String(
        (
          await post(`/workspaces/${ws}/docs`, {
            docId: `ferry-${width}`,
            type: 'mockup',
            sourceUrl: file,
          })
        ).docId,
      );
      await post(`/workspaces/${ws}/docs:attach`, { docId });
      const mockPath = `/workspaces/${ws}/mockups/${docId}`;
      const thread = async (page: string, id: string, tag: string, text: string, said: string) =>
        (
          (await post(`/workspaces/${ws}/docs/${docId}/threads`, {
            author: alice,
            text: said,
            anchor: anchorOn(mockPath, page, id, tag, text),
          })) as { thread: { id: string } }
        ).thread.id;
      const book = await thread('book', 'bk-seats', 'H2', 'Choose a seat', 'Which side gets sun?');
      const pay = await thread('pay', 'pay-btn', 'BUTTON', 'Pay 18.40', 'Show the card fee first.');

      step(`open the mock at ${width} wide, on Book`);
      await navigate(cdp, `${base}${mockPath}#book`);
      await poll('the widget drew its pins', () =>
        frame.eval(`document.querySelectorAll('.cfw-pin').length`).then((n) => (n ? true : null)),
      );
      await intercept();

      step('tap the Book pin, reply with Enter');
      await tap(
        cdp,
        frame,
        `document.querySelector('.cfw-pin[data-thread-id="${book}"]')`,
        'the Book pin',
      );
      const enter = await send(frame, docId, book, REPLIES.enter, 'enter');

      step('reply on the same thread with the Reply button');
      const button = await send(frame, docId, book, REPLIES.button, 'button');

      step('from Timetable, open Pay from the comment view, reply with Enter');
      // A fresh load: a move of the fragment alone keeps the document.
      await navigate(cdp, 'about:blank');
      await navigate(cdp, `${base}${mockPath}#timetable`);
      await poll('the widget drew its pins', () =>
        frame.eval(`!!${SHADOW}?.querySelector('.panel')`).then((v) => (v ? true : null)),
      );
      await intercept();
      step('tap Comments');
      await tap(cdp, top, `document.querySelector('[data-cw-comments]')`, 'Comments');
      await poll('the view opened', () =>
        frame.eval(`${SHADOW}?.querySelector('.panel.open') ? true : null`),
      );
      step('tap the Pay thread');
      await tap(
        cdp,
        frame,
        `${SHADOW}?.querySelector('.thread[data-thread-id="${pay}"] .snippet')`,
        'the Pay thread',
      );
      await poll('the Pay thread open', () => frame.eval(`${BOX} ? true : null`));
      const view = await send(frame, docId, pay, REPLIES.view, 'enter');

      runs[String(width)] = { enter, button, view };
    }
    cdp.close();
    process.stdout.write(`\n${JSON.stringify({ runs } satisfies Reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 200s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 200_000).unref();
await main();
process.exit(0);
