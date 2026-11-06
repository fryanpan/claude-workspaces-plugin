#!/usr/bin/env bun
/**
 * A thread resolved by an agent, seen on an attached app's page that is
 * already open, in headless Chromium against a real board server.
 *
 * Between the browser and the board stands a small forwarder, so the driver
 * can take the reader's connection away and give it back while the server
 * goes on working. A resolve goes straight to the server over the REST route
 * the MCP tool calls.
 *
 * Six arms on one open page, a thread each:
 *
 * - `live`: nothing wrong with the connection.
 * - `panel`: the same, with the comment list open on the thread.
 * - `reloaded`: the app's frame reloaded itself first, as a dev server does.
 * - `closed`: every connection is cut, new ones are refused, the thread is
 *   resolved, and the connection comes back.
 * - `woken`: the open connections stop carrying bytes and nothing tells the
 *   browser, as when a tablet sleeps or a network changes. New connections
 *   work. The page is then told it is visible again.
 * - `silent`: the same with no such word, so the page has no event at all.
 *
 * The frame is the opaque one, or with `frame-host` as the first argument the
 * one on the frame-only hostname.
 *
 * Spawned by `app-resolve.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns came from the running page and server.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, type Socket, createConnection, createServer as tcpServer } from 'node:net';
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
  Q,
  SHADOW,
  frameSessions,
  frameSurface,
  navigate,
  poll,
  ready,
  step,
  tapUntil,
  typeComment,
} from './draft-reload-page.ts';
import { buildWidget } from './frame-driver-kit.ts';

/** How long the driver reads a page before calling the resolve lost: past
 *  the longest a silent socket can last (`mock-host-liveness.ts`). */
export const READ_MS = 35_000;

export interface Arm {
  /** The thread showed as open before the resolve. */
  shownBefore: boolean;
  /** It stopped showing as open, inside `READ_MS`. */
  left: boolean;
  /** From the resolve, or the connection's return, to the pin leaving. */
  latencyMs: number;
  /** The arm's document is still the one on the page: nothing reloaded it. */
  sameDocument: boolean;
}

export interface Reading {
  frameOrigin: string | null;
  live: Arm;
  panel: Arm;
  reloaded: Arm;
  closed: Arm;
  woken: Arm;
  silent: Arm;
}

const BOARD_HOST = 'harborlight.board.localhost';
const FRAME_HOST = 'harborlight.frames.localhost';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Harborlight berths</title></head>
<body><h1 id="title">Harborlight berths</h1>
<p id="one">Riverbend opens at nine.</p>
<p id="two">Saltmarsh ferry runs at ten.</p>
<p id="three">The harbour office shuts at noon.</p>
<p id="four">Alice has the Harborlight keys.</p>
<p id="five">Bob sails on Tuesday.</p>
<p id="six">Moorings are free in winter.</p>
</body></html>`;

/** A forwarder from one port to the board, which can lose the connection. */
function forwarder() {
  const pairs = new Set<[Socket, Socket]>();
  let target = 0;
  let refusing = false;
  const server: Server = tcpServer((reader) => {
    if (refusing) {
      reader.destroy();
      return;
    }
    const board = createConnection({ host: '127.0.0.1', port: target });
    const pair: [Socket, Socket] = [reader, board];
    pairs.add(pair);
    for (const s of pair) {
      s.on('error', () => {});
      s.on('close', () => {
        reader.destroy();
        board.destroy();
        pairs.delete(pair);
      });
    }
    reader.pipe(board);
    board.pipe(reader);
  });
  return {
    async listen(): Promise<number> {
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const a = server.address();
      if (a === null || typeof a === 'string') throw new Error('no forwarder port');
      return a.port;
    },
    to(port: number) {
      target = port;
    },
    /** Cut every connection and refuse new ones. */
    cut() {
      refusing = true;
      for (const [a, b] of pairs) {
        a.destroy();
        b.destroy();
      }
    },
    restore() {
      refusing = false;
    },
    /** Stop carrying bytes on every open connection, and tell nobody. */
    silence() {
      for (const [a, b] of pairs) {
        a.unpipe(b);
        b.unpipe(a);
        a.pause();
        b.pause();
      }
      pairs.clear();
    },
    close() {
      for (const [a, b] of pairs) {
        a.destroy();
        b.destroy();
      }
      server.close();
    },
  };
}

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const onFrameHost = process.argv[2] === 'frame-host';
  const dir = mkdtempSync(join(tmpdir(), 'app-resolve-'));
  const net = forwarder();
  let handle: ServerHandle | undefined;
  let dev: ReturnType<typeof Bun.serve> | undefined;
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    const port = await net.listen();
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      requireSignInToWrite: false,
      ...(onFrameHost
        ? {
            accessOnlyBrowserHosts: false,
            trustedHosts: [BOARD_HOST],
            frameOrigin: `http://${FRAME_HOST}:${port}`,
            frameBoardHosts: [BOARD_HOST],
          }
        : {}),
    });
    net.to(handle.port);
    const h = handle;
    const api = `http://127.0.0.1:${h.port}`;
    const base = `http://${onFrameHost ? BOARD_HOST : '127.0.0.1'}:${port}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${api}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
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
    dev = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(PAGE, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        }),
    });
    const docId = 'harborlight-berths';
    const { prefix } = (await post(`/workspaces/${ws}/apps`, {
      docId,
      origin: `http://127.0.0.1:${dev.port}`,
    })) as { prefix: string };

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `app-resolve-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const sessions = await frameSessions(cdp);
    const frame = frameSurface(cdp, sessions);

    step('open the app');
    await navigate(cdp, `${base}${prefix}`);
    await ready(frame);
    const frameOrigin = (await frame.eval('location.origin')) as string | null;

    const threadOn = async (id: string): Promise<string> => {
      const text = `Please check ${id}`;
      await typeComment(cdp, frame, text, id);
      await tapUntil(cdp, frame, Q('.composer .submit'), `!${Q('.composer')}`, 'Post');
      const t = await poll(
        `the comment on ${id} reached the board`,
        () => h.docStore.listThreads(docId).find((x) => x.comments[0]?.text === text) ?? null,
        300,
      );
      return t.id;
    };
    const pin = (id: string) => `document.querySelector('.cfw-pin[data-thread-id="${id}"]')`;
    const pinned = async (id: string) => (await frame.eval(`!!${pin(id)}`)) === true;
    const resolve = (id: string) =>
      post(`/workspaces/${ws}/docs/${docId}/threads/${id}/resolve`, { author: agent });

    const threads = {
      live: await threadOn('one'),
      panel: await threadOn('two'),
      reloaded: await threadOn('three'),
      closed: await threadOn('four'),
      woken: await threadOn('five'),
      silent: await threadOn('six'),
    };
    const allPinned = async () => {
      for (const id of Object.values(threads)) {
        await poll(`the pin of ${id} shows`, async () => ((await pinned(id)) ? true : null), 300);
      }
    };
    await allPinned();
    const mark = () => frame.eval('(window.__cwSameDocument = 1)');
    await mark();

    /** Read the page until `gone` says the thread left it, from `t0`. */
    const watch = async (
      gone: () => Promise<boolean>,
      t0: number,
    ): Promise<Omit<Arm, 'shownBefore'>> => {
      let left = false;
      while (performance.now() - t0 < READ_MS) {
        if (await gone()) {
          left = true;
          break;
        }
        await sleep(25);
      }
      return {
        left,
        latencyMs: Math.round(performance.now() - t0),
        sameDocument: (await frame.eval('window.__cwSameDocument === 1')) === true,
      };
    };
    const pinGone = (id: string) => async () => !(await pinned(id));

    step('resolve with the connection up');
    const shownLive = await pinned(threads.live);
    let t0 = performance.now();
    await resolve(threads.live);
    const live = { shownBefore: shownLive, ...(await watch(pinGone(threads.live), t0)) };

    step('resolve with the comment list open');
    await frame.eval(`window.dispatchEvent(new Event('cw-comments'))`);
    const openRow = `${SHADOW}?.querySelector('.thread.status-open[data-thread-id="${threads.panel}"]')`;
    const shownPanel = await poll(
      'the thread is listed as open',
      async () => ((await frame.eval(`!!${openRow}`)) === true ? true : null),
      300,
    );
    t0 = performance.now();
    await resolve(threads.panel);
    const panel = {
      shownBefore: shownPanel,
      ...(await watch(async () => (await frame.eval(`!${openRow}`)) === true, t0)),
    };
    await frame.eval(`window.dispatchEvent(new Event('cw-comments'))`);

    step('resolve after the frame reloaded');
    await frame.eval('location.reload()');
    await poll(
      'the frame reloaded',
      async () => ((await frame.eval('window.__cwSameDocument === 1')) === false ? true : null),
      300,
    );
    await ready(frame);
    await poll(
      'the reloaded frame shows its pin',
      async () => ((await pinned(threads.reloaded)) ? true : null),
      300,
    ).catch(() => null);
    const shownReloaded = await pinned(threads.reloaded);
    await mark();
    t0 = performance.now();
    await resolve(threads.reloaded);
    const reloaded = {
      shownBefore: shownReloaded,
      ...(await watch(pinGone(threads.reloaded), t0)),
    };

    step('resolve with the connection cut');
    const shownClosed = await pinned(threads.closed);
    net.cut();
    await resolve(threads.closed);
    await sleep(1500);
    net.restore();
    const closed = {
      shownBefore: shownClosed,
      ...(await watch(pinGone(threads.closed), performance.now())),
    };

    step('resolve with the connection silent, then wake the page');
    const shownWoken = await pinned(threads.woken);
    net.silence();
    await resolve(threads.woken);
    t0 = performance.now();
    await cdp.evaluate(`document.dispatchEvent(new Event('visibilitychange'))`);
    const woken = { shownBefore: shownWoken, ...(await watch(pinGone(threads.woken), t0)) };

    step('resolve with the connection silent');
    const shownSilent = await pinned(threads.silent);
    net.silence();
    await resolve(threads.silent);
    const silent = {
      shownBefore: shownSilent,
      ...(await watch(pinGone(threads.silent), performance.now())),
    };

    cdp.close();
    const reading: Reading = { frameOrigin, live, panel, reloaded, closed, woken, silent };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    net.close();
    dev?.stop(true);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
