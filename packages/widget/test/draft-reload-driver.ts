#!/usr/bin/env bun
/**
 * A comment half-typed, and words half-edited, when the page reloads under
 * the reader — in headless Chromium against a real board server.
 *
 * Three pages, because the widget lives on three kinds: a dev server attached
 * to the board and opened through its app address (the page is a sandboxed
 * frame, and the dev server's own live reload reloads it), a mock the board
 * serves (the reader reloads it, then the agent writes a new round), and a
 * plain page on its own port that embeds the widget directly.
 *
 * On each the driver edits the paragraph's words and leaves them unsent,
 * opens comment mode, taps the heading and types a comment, then reloads and
 * reads what the page shows. Then the negative control on the app door: the
 * comment posted, a second one cancelled, the edits sent — reloaded after
 * each, nothing comes back.
 *
 * Spawned by `draft-reload.test.ts`, which reads the JSON it prints. The
 * page half — the words, the taps and the reads — is `draft-reload-page.ts`.
 *
 * Nothing here reads a source file, a bundle or a stylesheet to assert on;
 * every value it returns came from the running page and server.
 */
// audit: no-text
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import {
  COMMENT,
  EDITED,
  HEADING,
  LEDE,
  Q,
  type Reading,
  SHOWN,
  type Shown,
  type Surface,
  TAG,
  editLede,
  frameSessions,
  frameSurface,
  markDocument,
  navigate,
  pageSurface,
  poll,
  read,
  ready,
  reloaded,
  step,
  tap,
  tapUntil,
  typeComment,
} from './draft-reload-page.ts';

const body = () =>
  `<h1 id="title">${HEADING}</h1><p id="lede">${LEDE}</p>` +
  '<p id="ferry">Saltmarsh ferry times</p>';

const style = '<style>body{font:16px/1.5 system-ui;margin:0;padding:40px 60px}</style>';

/** A site's page with its dev server's reload script, as a static site's dev script has it. */
const appPage = (marker: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Harborlight</title>${style}</head>
<body>${body()}<p id="build">${marker}</p>
<script>new EventSource('__reload').addEventListener('reload', () => location.reload());</script>
</body></html>`;

/** A plain page that embeds the widget from the board. */
const plainPage = (board: string, ws: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Harborlight</title>${style}</head>
<body>${body()}
<${TAG} doc-id="harborlight-plain" workspace-id="${ws}" user="Alice" server-url="ws://${board}"></${TAG}>
<script src="http://${board}/widget.iife.js"></script>
</body></html>`;

/** A mock the board serves; round two adds a paragraph. */
const mockPage = (round: number) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Harborlight mock</title>${style}</head>
<body>${body()}${round > 1 ? '<p id="round-two">Riverbend round two</p>' : ''}</body></html>`;

async function buildWidget(dist: string): Promise<void> {
  const src = (f: string) => join(import.meta.dirname, '../src', f);
  const built = await Bun.build({
    entrypoints: [
      src('widget-iife.ts'),
      src('mockup-live.ts'),
      src('mic-entry.ts'),
      src('voice/voice-entry.ts'),
      src('edit/edit-entry.ts'),
      src('mock-bridge.ts'),
      src('mock-host.ts'),
    ],
    outdir: dist,
    target: 'browser',
    format: 'iife',
    naming: '[name].js',
  });
  if (!built.success) throw new Error(`widget build failed: ${built.logs.join('\n')}`);
  renameSync(join(dist, 'widget-iife.js'), join(dist, 'widget.iife.js'));
  renameSync(join(dist, 'mic-entry.js'), join(dist, 'mic.js'));
  renameSync(join(dist, 'voice-entry.js'), join(dist, 'voice.js'));
  renameSync(join(dist, 'edit-entry.js'), join(dist, 'edit.js'));
}

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'draft-reload-'));
  let handle: ServerHandle | undefined;
  const devs: Array<ReturnType<typeof Bun.serve>> = [];
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
    const board = `127.0.0.1:${h.port}`;
    const base = `http://${board}`;
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

    // The app: a dev server whose reload stream fires on a request here.
    const enc = new TextEncoder();
    const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
    let appBuild = 1;
    const app = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      fetch(req) {
        if (new URL(req.url).pathname.endsWith('__reload')) {
          let mine: ReadableStreamDefaultController<Uint8Array> | undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                mine = c;
                streams.add(c);
                c.enqueue(enc.encode(': open\n\n'));
              },
              cancel() {
                if (mine) streams.delete(mine);
              },
            }),
            { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } },
          );
        }
        return new Response(appPage(`build ${appBuild}`), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      },
    });
    devs.push(app);
    const liveReload = async (s: Surface) => {
      await poll('the app has its reload stream open', () => (streams.size > 0 ? true : null));
      await markDocument(s);
      appBuild += 1;
      for (const c of [...streams]) {
        try {
          c.enqueue(enc.encode('event: reload\ndata: 1\n\n'));
        } catch {
          streams.delete(c);
        }
      }
      await reloaded(s);
    };
    const appDoc = 'harborlight-app';
    const { prefix } = (await post(`/workspaces/${ws}/apps`, {
      docId: appDoc,
      origin: `http://127.0.0.1:${app.port}`,
    })) as { prefix: string };
    const appUrl = `${base}${prefix}`;

    // The plain page, from its own dev server, at any path.
    const plain = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(plainPage(board, ws), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        }),
    });
    devs.push(plain);
    const plainUrl = `http://127.0.0.1:${plain.port}/`;

    // The mock: bound from a file, served by the board.
    const mockFile = join(dir, 'mock.html');
    writeFileSync(mockFile, mockPage(1));
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
    const mockUrl = `${base}/workspaces/${ws}/mockups/${mockId}`;

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `draft-reload-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // A page that asks before it unloads would hold a reload: accept, and
    // let the readings say what came back.
    cdp.on('Page.javascriptDialogOpening', () => {
      step('a dialog opened: accepting it');
      void cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
    const sessions = await frameSessions(cdp);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1180,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const frame = frameSurface(cdp, sessions);
    const page = pageSurface(cdp);
    const typedOn = (x: Shown) => x.open && x.text === COMMENT && x.lede === EDITED && x.bars > 0;
    const back = (x: Shown) => x.open && x.text === COMMENT && x.lede === EDITED && x.bars > 0;

    // ---- the app door: the dev server's live reload reloads the frame ----
    step(`open the app door ${appUrl}`);
    await navigate(cdp, appUrl);
    await ready(frame);
    await editLede(cdp, frame);
    await typeComment(cdp, frame, COMMENT);
    const appTyped = await read(frame, typedOn);
    step('live reload');
    await liveReload(frame);
    await ready(frame);
    const appReloaded = await read(frame, back);

    // ---- the mock: the reader reloads, then the agent writes round two ----
    step(`open the mock ${mockUrl}`);
    await navigate(cdp, mockUrl);
    await ready(frame);
    await editLede(cdp, frame);
    await typeComment(cdp, frame, COMMENT);
    const mockTyped = await read(frame, typedOn);
    step('reader reloads the mock');
    await navigate(cdp, mockUrl);
    await ready(frame);
    const mockReloaded = await read(frame, back);
    step('agent writes round two');
    writeFileSync(mockFile, mockPage(2));
    const roundTwo = await poll(
      'round two swapped in',
      () =>
        frame
          .eval(`!!document.getElementById('round-two')`)
          .then((v) => (v === true ? true : null)),
      400,
    ).catch(() => false);
    // A frame after the swap, for the widget's render to have run over it.
    await sleep(300);
    const mockSwapped = { ...(await read(frame, back)), roundTwo };

    // ---- the plain page: it reloads itself ----
    step(`open the plain page ${plainUrl}`);
    await navigate(cdp, plainUrl);
    await ready(page);
    await editLede(cdp, page);
    await typeComment(cdp, page, COMMENT);
    const plainTyped = await read(page, typedOn);
    step('another page on the same site');
    await navigate(cdp, `${plainUrl}riverbend`);
    await ready(page);
    // Given the time a draft takes to come back on its own page.
    await sleep(1000);
    const plainOtherPage = (await page.eval(SHOWN)) as Shown;
    step('back, reloaded');
    await navigate(cdp, plainUrl);
    await ready(page);
    const plainReloaded = await read(page, back);

    // ---- the negative control, on the app door ----
    // A step that cannot run (the draft it needs never came back) records
    // what it could and lets the next one start, so the test names what broke.
    const attempt = async <T>(what: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        step(`${what} could not run: ${String(err)}`);
        return fallback;
      }
    };
    const nothing: Shown = { mode: true, open: true, text: null, on: null, lede: null, bars: 0 };

    step('negative control: post, cancel, send');
    await navigate(cdp, appUrl);
    await ready(frame);
    await read(frame, back);
    const afterPost = await attempt('post', { ...nothing, posted: false }, async () => {
      await tapUntil(cdp, frame, Q('.composer .submit'), `!${Q('.composer')}`, 'Post');
      const posted = await poll(
        'the comment reached the board',
        () =>
          h.docStore.listThreads(appDoc).some((t) => t.comments[0]?.text === COMMENT) ? true : null,
        200,
      ).catch(() => false);
      await liveReload(frame);
      await ready(frame);
      await sleep(1000);
      return { ...((await frame.eval(SHOWN)) as Shown), posted };
    });

    const afterCancel = await attempt('cancel', nothing, async () => {
      await typeComment(cdp, frame, 'Riverbend second thoughts', 'ferry');
      await tap(cdp, frame, Q('.composer .cancel'), 'Cancel');
      await poll('the composer closed', () =>
        frame.eval(`!${Q('.composer')}`).then((v) => (v ? true : null)),
      );
      await liveReload(frame);
      await ready(frame);
      await sleep(1000);
      return (await frame.eval(SHOWN)) as Shown;
    });

    const afterSend = await attempt(
      'send',
      { sent: false, unsent: null as number | null },
      async () => {
        await tapUntil(cdp, frame, Q('.fab-edit'), Q('.cw-edit-banner'), 'the pencil');
        await tap(cdp, frame, Q('.cw-edit-banner .edit-send:not([hidden])'), 'Send');
        const sent = await poll(
          'the edits reached the board',
          () =>
            h.docStore.listThreads(appDoc).some((t) => t.comments[0]?.pageEdits) ? true : null,
          200,
        ).catch(() => false);
        await liveReload(frame);
        await ready(frame);
        await sleep(1000);
        await tapUntil(cdp, frame, Q('.fab-edit'), Q('.cw-edit-banner'), 'the pencil');
        await sleep(300);
        const unsent = (await frame.eval(
          `(() => { const c = ${Q('.cw-edit-banner .edit-count')}; return c && !c.hidden ? parseInt(c.textContent, 10) : 0; })()`,
        )) as number | null;
        return { sent, unsent };
      },
    );

    cdp.close();
    const reading: Reading = {
      typed: { app: appTyped, mock: mockTyped, plain: plainTyped },
      appReloaded,
      mockReloaded,
      mockSwapped,
      plainReloaded,
      plainOtherPage,
      afterPost,
      afterCancel,
      afterSend,
    };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    for (const d of devs) d.stop(true);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

// A driver that never finishes holds a browser open; the test's own spawn
// timeout is longer than this.
setTimeout(() => {
  step('gave up after 200s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 200_000).unref();
await main();
process.exit(0);
