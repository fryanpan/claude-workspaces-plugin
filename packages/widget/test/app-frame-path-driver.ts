#!/usr/bin/env bun
/**
 * An attached app whose router has no base path, in headless Chromium against
 * a real board server: its script takes the app's prefix off the frame's
 * address with `history.replaceState`, so the frame's address names a path
 * outside the door. Run once in each frame the board hands out: the opaque
 * frame on the board's own hostname, and the frame on the frame-only hostname
 * (`server/src/frame-host.ts`).
 *
 * Three things happen to that frame, with nothing changed in the app: its own
 * script reloads it, the same with the query dropped from the address, and a
 * faded pin on a thread made at another query is tapped.
 *
 * Spawned by `app-frame-path.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns came from the running page and server.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
  type Surface,
  frameSessions,
  frameSurface,
  markDocument,
  navigate,
  poll,
  ready,
  step,
  tapUntil,
  typeComment,
} from './draft-reload-page.ts';
import { buildWidget, sleep } from './frame-driver-kit.ts';

const BOARD_HOST = 'harborlight.board.localhost';
const FRAME_HOST = 'harborlight.frames.localhost';

/** What the frame held at one moment. `app` is false for anything else. */
export interface Held {
  app: boolean;
  /** The frame's address, as the app's own script reads it. */
  address: string | null;
  /** The route the app drew, and the query it saw. */
  route: string | null;
  query: string | null;
  /** What a frame that is not the app says, when no app holds it. */
  text: string | null;
  /** This document is not the one `markDocument` marked. */
  fresh: boolean;
}

export interface FrameReading {
  /** The frame on first load, the app having taken its prefix off. */
  opened: Held;
  /** After the app's script called `location.reload()`. */
  reloaded: Held;
  /** The same, with the query dropped from the address before the reload. */
  reloadedBare: Held;
  /** The context the widget stored for a comment made in this frame. */
  storedContext: string | null;
  /** The pin's state on the page the thread was not made at. */
  pinDimmed: boolean;
  /** After tapping that pin. */
  pinTapped: Held;
  /** The thread's comment shows in the widget after the tap. */
  threadShown: boolean;
}

export interface Reading {
  opaque: FrameReading;
  frameHost: FrameReading;
  /** The top-level visit to the same outside path, on the board's hostname. */
  topLevel: { status: number; body: string };
}

/** The route is drawn after the prefix is gone, as a router would. */
const appPage = `<!doctype html><html><head><meta charset="utf-8"><title>Harborlight</title></head>
<body style="margin:120px 40px"><h1 id="title">Harborlight berths</h1><p id="route"></p><p id="query"></p>
<script>
  const door = /^\\/workspaces\\/[^/]+\\/apps\\/[^/]+/.exec(location.pathname);
  if (door) {
    history.replaceState(null, '', (location.pathname.slice(door[0].length) || '/') + location.search + location.hash);
  }
  document.getElementById('route').textContent = location.pathname;
  document.getElementById('query').textContent = location.search;
</script></body></html>`;

const HELD = `(() => ({
  app: true,
  address: location.pathname + location.search,
  route: document.getElementById('route').textContent,
  query: document.getElementById('query').textContent,
  text: null,
  fresh: window.__cwBefore === undefined,
}))()`;

/** What every frame says when none holds the app. */
async function strayText(cdp: Cdp, sessions: string[]): Promise<string | null> {
  for (const sessionId of [...sessions]) {
    const r = (await cdp
      .send(
        'Runtime.evaluate',
        {
          expression: 'location.href + " :: " + (document.body?.innerText ?? "").slice(0, 120)',
          returnByValue: true,
        },
        sessionId,
      )
      .catch(() => null)) as { result?: { value?: string } } | null;
    if (r?.result?.value) return r.result.value;
  }
  return null;
}

/** The app in the frame with `settled` true of it, or what the frame holds
 *  instead once the wait is over. */
async function held(
  cdp: Cdp,
  sessions: string[],
  s: Surface,
  settled: (h: Held) => boolean,
): Promise<Held> {
  for (let i = 0; i < 100; i++) {
    const h = (await s.eval(HELD).catch(() => null)) as Held | null;
    if (h && settled(h)) return h;
    await sleep(50);
  }
  return {
    app: false,
    address: null,
    route: null,
    query: null,
    text: await strayText(cdp, sessions),
    fresh: false,
  };
}

async function walk(
  cdp: Cdp,
  sessions: string[],
  threads: (doc: string) => { anchor?: unknown; comments: { text: string }[] }[],
  base: string,
  prefix: string,
  doc: string,
): Promise<FrameReading> {
  const frame = frameSurface(cdp, sessions);
  const see = (want: (h: Held) => boolean) => held(cdp, sessions, frame, want);
  const onRoute = (h: Held) => h.route === '/insights';
  const reloadedOnRoute = (h: Held) => onRoute(h) && h.fresh;

  step(`open ${base}`);
  await navigate(cdp, `${base}${prefix}insights?tab=a`);
  await ready(frame);
  const opened = await see(onRoute);

  step('the app reloads its frame');
  await markDocument(frame);
  await frame.eval('location.reload()');
  const reloadedHeld = await see(reloadedOnRoute);

  step('the same with the query gone from the address');
  await navigate(cdp, `${base}${prefix}insights?tab=a`);
  await ready(frame);
  await see(onRoute);
  await markDocument(frame);
  await frame.eval(`(history.replaceState(null, '', '/insights'), location.reload())`);
  const reloadedBare = await see(reloadedOnRoute);

  step('comment at one query, open another, tap the faded pin');
  await navigate(cdp, `${base}${prefix}insights?tab=b`);
  await ready(frame);
  await see(onRoute);
  const words = `Riverbend berth note ${doc}`;
  const before = threads(doc).length;
  await typeComment(cdp, frame, words);
  await tapUntil(cdp, frame, Q('.composer .submit'), `!${Q('.composer')}`, 'Post');
  const made = await poll(
    'the comment reached the board',
    () =>
      threads(doc)
        .slice(before)
        .find((t) => t.comments[0]?.text === words) ?? null,
    300,
  );
  const storedContext =
    (made.anchor as { context?: { url?: string } } | undefined)?.context?.url ?? null;

  await navigate(cdp, `${base}${prefix}insights?tab=a`);
  await ready(frame);
  await see(onRoute);
  const dim = FADED_PIN;
  const pinDimmed = await poll(
    'the faded pin drew',
    () => frame.eval(`${dim}?.dataset.dim !== undefined || null`),
    200,
  ).then(
    (v) => v === true,
    () => false,
  );
  // A pin is redrawn with the page, so a press and its release can land on
  // two elements and make no click.
  await tapUntil(cdp, frame, dim, `location.search.includes('tab=b')`, 'the faded pin').catch(
    () => {},
  );
  // The widget takes `cw-goto` off the address only with its line to the
  // board working, so this reads that too.
  const pinTapped = await see(
    (h) =>
      onRoute(h) && h.query?.includes('tab=b') === true && h.address?.includes('cw-goto') === false,
  );
  const threadShown = await poll('the thread shows', () =>
    frame
      .eval(`(document.querySelector('claude-feedback-widget')?.shadowRoot?.textContent ?? '')`)
      .then((t) => (String(t).includes(words) ? true : null)),
  ).then(
    (v) => v === true,
    () => false,
  );
  return {
    opened,
    reloaded: reloadedHeld,
    reloadedBare,
    storedContext,
    pinDimmed,
    pinTapped,
    threadShown,
  };
}

/** The pin, wherever the widget's layer holds it. */
const FADED_PIN = `(document.querySelector('.cfw-pin') ?? ${Q('.cfw-pin')})`;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'app-frame-path-'));
  let browser: { proc: ChildProcess; profile: string } | undefined;
  let handle: ServerHandle | undefined;
  let dev: ReturnType<typeof Bun.serve> | undefined;
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    // The frame origin names the port, so learn a free one first.
    const probe = createServer({ port: 0, dataDir: join(dir, 'probe') });
    const port = probe.port;
    await probe.stop();
    handle = createServer({
      port,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      requireSignInToWrite: false,
      accessOnlyBrowserHosts: false,
      trustedHosts: [BOARD_HOST],
      frameOrigin: `http://${FRAME_HOST}:${port}`,
      frameBoardHosts: [BOARD_HOST],
    });
    const h = handle;
    const api = `http://127.0.0.1:${port}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${api}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    dev = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(appPage, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        }),
    });
    const agent = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' };
    const ws = String(
      (
        (await post('/workspaces', { name: 'Harborlight', author: agent })) as {
          workspace: { id: string };
        }
      ).workspace.id,
    );
    const attach = async (docId: string) => {
      const a = await post(`/workspaces/${ws}/apps`, {
        docId,
        origin: `http://127.0.0.1:${dev?.port}`,
      });
      return { doc: String(a.docId), prefix: String(a.prefix) };
    };
    const opaqueApp = await attach('harborlight-opaque');
    const framedApp = await attach('harborlight-framed');

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `app-frame-path-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const sessions = await frameSessions(cdp);
    const threads = (doc: string) =>
      h.docStore.listThreads(doc) as unknown as {
        anchor?: unknown;
        comments: { text: string }[];
      }[];

    // 127.0.0.1 is not one of the frame hostname's board hosts: opaque frame.
    const opaque = await walk(cdp, sessions, threads, api, opaqueApp.prefix, opaqueApp.doc);
    const frameHost = await walk(
      cdp,
      sessions,
      threads,
      `http://${BOARD_HOST}:${port}`,
      framedApp.prefix,
      framedApp.doc,
    );
    const top = await fetch(`${api}/insights?cw-frame=1`, {
      headers: { 'sec-fetch-dest': 'document' },
    });
    const topLevel = { status: top.status, body: (await top.text()).slice(0, 200) };
    cdp.close();
    const reading: Reading = { opaque, frameHost, topLevel };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    await dev?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
