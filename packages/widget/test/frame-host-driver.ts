#!/usr/bin/env bun
/**
 * Attachments framed on the project's frame hostname
 * (`server/src/frame-host.ts`), in headless Chromium against a real board
 * server.
 *
 * The board is `harborlight.board.localhost:<port>` and the frame hostname is
 * `harborlight.frames.localhost:<port>`, the same server under a second name
 * on another domain, as the router would give it one. Every frame there loads
 * only with the board's frame ticket (`server/src/frame-ticket.ts`). Two
 * attachments, and two pages that are not the board's:
 *
 * - A mock whose script tries to read the board's cookie and storage: its own
 *   `document.cookie` and `localStorage`, and the page holding it through
 *   `parent` and `top`. It reports what it saw to its own doc through the
 *   bridge, which is the one write the frame is meant to have. The CONTROL is
 *   the same reads run on the board's page itself, where the planted cookie
 *   and stored value must both show: an absence in the frame is then the
 *   origin boundary, not a value that was never there. The mock's script also
 *   sets a cookie on the board's domain and the board's hostname, and the
 *   board's page looks for both afterwards.
 * - A page on another hostname of the board's domain, setting a cookie on
 *   that domain the same way: the CONTROL that such a cookie, set from the
 *   board's own site, does reach the board's page.
 * - An app door, standing in for a site's staging door: a dev server on
 *   loopback attached to the board, whose page loads its own stylesheet and
 *   script under the app's prefix. The reader opens it, and a comment is
 *   typed and posted through the widget inside the frame.
 * - Another project's frame, `riverbend.frames.localhost`, held by
 *   Riverbend's board, whose page asks for the staging door's script on
 *   Harborlight's frame hostname. The reader's cookie for Harborlight is in
 *   the same partition, so only the server's rule refuses it.
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
  /** The page's own query, as it ended up after any redirect. */
  search: string;
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
  /** The board page's cookies after the frame and the control planted theirs. */
  boardAfter: string;
  /** What Riverbend's frame got asking for Harborlight's door script. */
  riverbend: { loaded: boolean | null; upstreamHits: number };
  door: {
    origin: string | null;
    /** The app's own script, as many times as the dev server served it. */
    upstreamHits: number;
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
    search: location.search,
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
  for (const d of ${JSON.stringify(PLANT_DOMAINS)}) {
    document.cookie = '${FRAME_PLANT}=1; domain=' + d + '; path=/';
  }
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

/** The board's domain, and the board's hostname, as the mock tries to plant. */
const BOARD_DOMAIN = 'board.localhost';
const BOARD_HOST = `harborlight.${BOARD_DOMAIN}`;
const FRAME_HOST = 'harborlight.frames.localhost';
const PLANT_DOMAINS = [BOARD_DOMAIN, BOARD_HOST];
/** The cookie the mock's script tries to set on the board. */
export const FRAME_PLANT = 'cw_frame_plant';
/** The cookie the control page on the board's domain sets the same way. */
export const CONTROL_PLANT = 'cw_control_plant';

/** Riverbend's frame, asking for Harborlight's door script. */
const riverbendFrame = (src: string) => `<!doctype html><html><body><script>
const s = document.createElement('script');
s.src = ${JSON.stringify(src)};
s.onload = () => fetch('/report?loaded=1');
s.onerror = () => fetch('/report?loaded=0');
document.head.appendChild(s);
</script></body></html>`;

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
      // The board's test hostname, as a name for this machine: the
      // access-only default grants loopback names alone.
      accessOnlyBrowserHosts: false,
      trustedHosts: [BOARD_HOST],
      frameOrigin: `http://${FRAME_HOST}:${port}`,
      frameBoardHosts: [BOARD_HOST],
    });
    const h = handle;
    const api = `http://127.0.0.1:${port}`;
    const base = `http://${BOARD_HOST}:${port}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${api}${path}`, {
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
    // The same listener answers the control page and Riverbend's two pages,
    // told apart by Host.
    let prefix = '';
    let doorJsHits = 0;
    let riverbendLoaded: boolean | null = null;
    door = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const u = new URL(req.url);
        const p = u.pathname;
        const html = (body: string) =>
          new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
        const at = (req.headers.get('host') ?? '').split(':')[0];
        if (at === `control.${BOARD_DOMAIN}`) {
          return html(
            `<script>document.cookie = '${CONTROL_PLANT}=1; domain=${BOARD_DOMAIN}; path=/';</script>`,
          );
        }
        if (at === `riverbend.${BOARD_DOMAIN}`) {
          return html(`<iframe src="http://riverbend.frames.localhost:${u.port}/frame"></iframe>`);
        }
        if (at === 'riverbend.frames.localhost') {
          if (p === '/report') {
            riverbendLoaded = u.searchParams.get('loaded') === '1';
            return new Response('ok');
          }
          return html(riverbendFrame(`http://${FRAME_HOST}:${port}${prefix}door.js`));
        }
        if (p.endsWith('/door.css')) {
          return new Response('h1{color:rgb(4, 5, 6)}', {
            headers: { 'content-type': 'text/css' },
          });
        }
        if (p.endsWith('/door.js')) {
          doorJsHits++;
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
    const doorHits = doorJsHits;
    await typeComment(cdp, frame, COMMENT);
    await tapUntil(cdp, frame, Q('.composer .submit'), `!${Q('.composer')}`, 'Post');
    const thread = await poll(
      'the comment reached the board',
      () => h.docStore.listThreads(doorDoc).find((t) => t.comments[0]?.text === COMMENT) ?? null,
      300,
    ).catch(() => null);
    const first = thread?.comments[0];

    // The control plants on the board's domain from a page on that domain,
    // then the board's page reads what reached it.
    step("plant from the board's own domain");
    await navigate(cdp, `http://control.${BOARD_DOMAIN}:${door.port}/`);
    await navigate(cdp, `${base}/workspaces/${ws}`);
    const boardAfter = (await cdp.evaluate('document.cookie')) as string;

    step("Riverbend's frame asks for Harborlight's script");
    await navigate(cdp, `http://riverbend.${BOARD_DOMAIN}:${door.port}/`);
    await poll('Riverbend reported', () => riverbendLoaded, 300).catch(() => null);

    const reading: FrameHostReading = {
      board: boardSight,
      frame: frameSight,
      boardAfter,
      riverbend: { loaded: riverbendLoaded, upstreamHits: doorJsHits - doorHits },
      door: {
        origin: doorOrigin,
        upstreamHits: doorHits,
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
