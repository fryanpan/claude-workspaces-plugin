#!/usr/bin/env bun
/**
 * Attachments framed on the frame-only hostname (`server/src/frame-host.ts`),
 * in headless Chromium against a real board server.
 *
 * The board is `127.0.0.1:<port>` and the frame hostname is
 * `frames.localhost:<port>`, the same server under a second name, as the
 * tunnel would give it one. Two attachments:
 *
 * - A mock whose script tries to read the board's cookie and storage: its own
 *   `document.cookie` and `localStorage`, and the page holding it through
 *   `parent` and `top`. It reports what it saw to its own doc through the
 *   bridge, which is the one write the frame is meant to have. The CONTROL is
 *   the same reads run on the board's page itself, where the planted cookie
 *   and stored value must both show: an absence in the frame is then the
 *   origin boundary, not a value that was never there.
 * - An app door, standing in for a site's staging door: a dev server on
 *   loopback attached to the board, whose page loads its own stylesheet and
 *   script under the app's prefix. The reader opens it, and a comment is
 *   typed and posted through the widget inside the frame.
 *
 * Spawned by `frame-host.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns came from the running page and server.
 */
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

/** The reader's display name on the board. Fictional. */
export const READER = 'Sample Reader';
/** What the board page plants, to be looked for from inside the frame. */
export const PLANTED = 'harborlight-planted';
export const COMMENT = 'Riverbend berth prices look right';

/** What one page could read of the board's cookie and storage. */
export interface Sight {
  origin: string;
  cookie: string;
  stored: string | null;
  /** The reader's name as this page's own storage holds it. */
  name: string | null;
  /** `parent`'s and `top`'s cookie and storage, or the error reading them. */
  parentCookie: string;
  parentStored: string;
  topCookie: string;
  /** Whether this page could write and read back its own storage. */
  ownStorage: boolean;
}

export interface FrameHostReading {
  /** The control: the reads, run on the board's own page. */
  board: Sight;
  /** The same reads from inside the mock's frame. */
  frame: Sight | null;
  door: {
    origin: string | null;
    /** The app's own script and stylesheet, loaded by the frame itself. */
    script: boolean;
    color: string | null;
    /** The comment typed through the widget, as the board stored it. */
    posted: { text: string; author: string | null } | null;
  };
}

/** The reads, as one function: run on the board page, and inside the frame. */
const SIGHT = `() => {
  const tryRead = (f) => { try { const v = f(); return v === null ? 'null' : String(v); } catch (e) { return 'refused:' + (e && e.name); } };
  let ownStorage = false;
  try { localStorage.setItem('cw-own-probe', '1'); ownStorage = localStorage.getItem('cw-own-probe') === '1'; localStorage.removeItem('cw-own-probe'); } catch {}
  let stored = null, name = null;
  try { stored = localStorage.getItem('cw-board-probe'); name = localStorage.getItem('feedback-user-name'); } catch {}
  return {
    origin: location.origin,
    cookie: document.cookie,
    stored,
    name,
    parentCookie: window.parent === window ? 'self' : tryRead(() => window.parent.document.cookie),
    parentStored: window.parent === window ? 'self' : tryRead(() => window.parent.localStorage.getItem('cw-board-probe')),
    topCookie: window.top === window ? 'self' : tryRead(() => window.top.document.cookie),
    ownStorage,
  };
}`;

const SPY = (ws: string, doc: string) => `<!doctype html><html><head><meta charset="utf-8">
<title>Harborlight tides</title></head><body><h1 id="title">Saltmarsh tides</h1>
<script>
(async () => {
  // A moment for the bridge's seed and the page holding it to settle.
  await new Promise((r) => setTimeout(r, 200));
  const seen = (${SIGHT})();
  await fetch('/workspaces/${ws}/docs/${doc}/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      author: { id: 'anon-reader', kind: 'known', name: 'Reader', color: '#08c' },
      text: 'sight:' + JSON.stringify(seen),
      anchor: { kind: 'subject' },
    }),
  });
})();
</script></body></html>`;

const doorPage = (prefix: string) => `<!doctype html><html><head><meta charset="utf-8">
<title>Harborlight staging</title>
<link rel="stylesheet" href="${prefix}door.css">
<script src="${prefix}door.js"></script>
<style>body{font:16px/1.5 system-ui;margin:0;padding:40px 60px}</style>
</head><body><h1 id="title">Harborlight Street Projects</h1>
<p id="lede">Riverbend opens at nine.</p></body></html>`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'frame-host-'));
  let handle: ServerHandle | undefined;
  let door: ReturnType<typeof Bun.serve> | undefined;
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
      frameOrigin: `http://frames.localhost:${port}`,
      frameBoardHosts: ['127.0.0.1'],
    });
    const h = handle;
    const base = `http://127.0.0.1:${port}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const agent = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
    const ws = String(
      (
        (await post('/workspaces', { name: 'Harborlight', author: agent })) as {
          workspace: { id: string };
        }
      ).workspace.id,
    );
    const spyFile = join(dir, 'tides.html');
    writeFileSync(spyFile, '<!doctype html><html><body></body></html>');
    const spy = String(
      (await post(`/workspaces/${ws}/docs`, { docId: 'tides', type: 'mockup', sourceUrl: spyFile }))
        .docId,
    );
    await post(`/workspaces/${ws}/docs:attach`, { docId: spy });
    writeFileSync(spyFile, SPY(ws, spy));

    // The staging door: a dev server on loopback, its links under the prefix.
    let prefix = '';
    door = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p.endsWith('/door.css')) {
          return new Response('h1{color:rgb(4, 5, 6)}', {
            headers: { 'content-type': 'text/css' },
          });
        }
        if (p.endsWith('/door.js')) {
          return new Response('window.__door = 1;', {
            headers: { 'content-type': 'text/javascript' },
          });
        }
        return new Response(doorPage(prefix), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      },
    });
    const doorDoc = 'harborlight-staging';
    prefix = String(
      (
        await post(`/workspaces/${ws}/apps`, {
          docId: doorDoc,
          origin: `http://127.0.0.1:${door.port}`,
        })
      ).prefix,
    );

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `frame-host-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const sessions = await frameSessions(cdp);
    const frame = frameSurface(cdp, sessions);

    // The board's page plants a cookie and a stored value, and the reader's
    // name as a board page stores it. Then the control reads them back there.
    // Planted on a board page that holds no mock: a mock loaded here would
    // report what it saw before the name was planted, and that report could
    // land after the count below and be read as the frame's.
    step('plant on the board');
    await navigate(cdp, `${base}/workspaces/${ws}`);
    await cdp.evaluate(
      `document.cookie = 'cw_board_probe=${PLANTED}; path=/'; ` +
        `localStorage.setItem('cw-board-probe', '${PLANTED}'); ` +
        `localStorage.setItem('feedback-user-name', ${JSON.stringify(READER)}); 1`,
    );
    const boardSight = (await cdp.evaluate(`(${SIGHT})()`)) as Sight;

    step('open the spy mock');
    const before = h.docStore.listThreads(spy).length;
    await navigate(cdp, `${base}/workspaces/${ws}/mockups/${spy}`);
    const report = await poll(
      'the frame reported to its own doc',
      () =>
        h.docStore
          .listThreads(spy)
          .slice(before)
          .find((t) => t.comments[0]?.text.startsWith('sight:')) ?? null,
      300,
    ).catch(() => null);
    const said = report?.comments[0]?.text;
    const frameSight = said ? (JSON.parse(said.slice('sight:'.length)) as Sight) : null;

    step('open the staging door');
    await navigate(cdp, `${base}${prefix}`);
    await ready(frame);
    const doorOrigin = (await frame.eval('location.origin')) as string | null;
    const doorScript = (await frame.eval('window.__door === 1')) === true;
    const doorColor = (await frame.eval(
      `getComputedStyle(document.getElementById('title')).color`,
    )) as string | null;
    await typeComment(cdp, frame, COMMENT);
    await tapUntil(cdp, frame, Q('.composer .submit'), `!${Q('.composer')}`, 'Post');
    const thread = await poll(
      'the comment reached the board',
      () => h.docStore.listThreads(doorDoc).find((t) => t.comments[0]?.text === COMMENT) ?? null,
      300,
    ).catch(() => null);
    const first = thread?.comments[0];

    const reading: FrameHostReading = {
      board: boardSight,
      frame: frameSight,
      door: {
        origin: doorOrigin,
        script: doorScript,
        color: doorColor,
        posted: first ? { text: first.text, author: first.author?.name ?? null } : null,
      },
    };
    cdp.close();
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    door?.stop(true);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
