#!/usr/bin/env bun
/**
 * The widget on an app page signs in through the popup and posts a comment
 * on the board token (`wt2`) it is handed, in a running browser.
 *
 * A real server that refuses unsigned writes, and an app page on another
 * origin (`localhost`, while the server is `127.0.0.1`) that pastes the tag
 * and the script. The browser holds the reader's session cookie for the
 * server's origin only, as it would after signing in on the board. The reader
 * then does what a person does: taps the widget, taps a paragraph, types,
 * taps Post. The server refuses the unsigned post, the composer offers "Sign
 * in", the reader taps it, the popup exchanges the session for a token and
 * hands it back, and the widget posts the draft with it.
 *
 * Spawned by `widget-sign-in-browser.test.ts`, which reads the JSON this
 * prints on its last line.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was measured in a running browser or
 * read off the server's own store.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailIdentityId } from '@claude-workspaces/core';
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

const TAG = 'claude-feedback-widget';
const SHADOW = `document.querySelector('${TAG}').shadowRoot`;
const EMAIL = 'alice@example.com';
const DOC = 'harborlight-timetable';
const WORDS = 'the last sailing is missing';

export interface SignInReading {
  /** The composer offered sign-in after the unsigned post was refused. */
  offered: boolean;
  /** The first four characters of the token the widget stored, or null. */
  tokenTag: string | null;
  /** The board the stored token names (its fifth field, decoded). */
  tokenBoard: string | null;
  /** The board the page's widget is on. */
  board: string;
  /** The comment the server holds on the page's doc, if any. */
  comment: { text: string; authorId: string } | null;
  /** Who the session cookie belongs to. */
  signedInAs: string;
}

async function buildWidget(dist: string): Promise<void> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dirname, '../src/widget-iife.ts')],
    outdir: dist,
    target: 'browser',
    format: 'iife',
    naming: '[name].js',
  });
  if (!built.success) throw new Error(`widget build failed: ${built.logs.join('\n')}`);
  renameSync(join(dist, 'widget-iife.js'), join(dist, 'widget.iife.js'));
}

/**
 * The emailed codes the log sender prints. Installed before the server is
 * created: the sender takes `console.log` when it is built.
 */
function captureCodes(): { codes: string[]; restore: () => void } {
  const codes: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    const m = args
      .map(String)
      .join(' ')
      .match(/login code for \S+: (\d{6})/);
    if (m?.[1]) codes.push(m[1]);
  };
  return { codes, restore: () => (console.log = log) };
}

/** Sign in over HTTP with the emailed code, and answer the session cookie's value. */
async function signIn(base: string, codes: string[]): Promise<string> {
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const started = await post('/api/auth/start', { email: EMAIL });
  if (!started.ok || codes.length === 0) throw new Error('sign-in start failed');
  const verified = await post('/api/auth/verify', { email: EMAIL, code: codes.at(-1) });
  if (!verified.ok) throw new Error(`sign-in verify failed: ${verified.status}`);
  const pair = (verified.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return pair.slice(pair.indexOf('=') + 1);
}

function pageHtml(serverPort: number, board: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:15px/1.5 system-ui;margin:0} header{padding:24px} main{padding:160px 24px}</style>
</head><body>
<header><h1 id="title">Harborlight ferry times</h1></header>
<main><p id="sailings">Six sailings a day from Riverbend.</p></main>
<${TAG} doc-id="${DOC}" workspace-id="${board}" user="Alice"
  server-url="ws://127.0.0.1:${serverPort}"></${TAG}>
<script src="http://127.0.0.1:${serverPort}/widget.iife.js"></script>
</body></html>`;
}

async function poll<T>(what: string, read: () => Promise<T | null> | T | null): Promise<T | null> {
  for (let i = 0; i < 200; i++) {
    const v = await read();
    if (v !== null && v !== undefined && v !== false) return v;
    await sleep(100);
  }
  process.stderr.write(`never happened: ${what}\n`);
  return null;
}

async function main(): Promise<void> {
  process.env.CW_LOG_LOGIN_CODES = '1';
  const dir = mkdtempSync(join(tmpdir(), 'widget-sign-in-'));
  let handle: ServerHandle | undefined;
  let page: ReturnType<typeof Bun.serve> | undefined;
  let browser: { proc: ChildProcess; profile: string } | undefined;
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    const captured = captureCodes();
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      emailCodeSignIn: true,
      requireSignInToWrite: true,
    });
    const serverPort = handle.port;
    const base = `http://127.0.0.1:${serverPort}`;
    const board = handle.tasks.createWorkspace('Harborlight').id;
    const session = await signIn(base, captured.codes).finally(captured.restore);
    page = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(pageHtml(serverPort, board), { headers: { 'content-type': 'text/html' } }),
    });

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `widget-sign-in-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    // The reader signed in on the board earlier: the cookie is the server's
    // origin's, and the app page's requests never carry it.
    await cdp.send('Network.setCookie', {
      name: 'cw_session',
      value: session,
      url: base,
      httpOnly: true,
      sameSite: 'Lax',
    });
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `http://localhost:${page.port}/` });
    await loaded;

    const centre = (expr: string) =>
      cdp.evaluate(`(() => { const e = ${expr}; if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as Promise<{
        x: number;
        y: number;
      } | null>;
    const press = async (expr: string, what: string): Promise<void> => {
      const p = await poll(what, () => centre(expr));
      if (!p) throw new Error(`nothing to press for ${what}`);
      for (const type of ['mousePressed', 'mouseReleased'] as const) {
        await cdp.send('Input.dispatchMouseEvent', {
          type,
          x: p.x,
          y: p.y,
          button: 'left',
          clickCount: 1,
          buttons: type === 'mousePressed' ? 1 : 0,
          pointerType: 'mouse',
        });
      }
    };

    await press(`${SHADOW}?.querySelector('.fab')`, 'the widget button');
    // The mode's banner sits across the top, so the press is on the paragraph.
    await press(`document.getElementById('sailings')`, 'the paragraph');
    await poll('the composer', () =>
      cdp.evaluate(`!!${SHADOW}.querySelector('.composer textarea')`),
    );
    await cdp.evaluate(`${SHADOW}.querySelector('.composer textarea').focus()`);
    await cdp.send('Input.insertText', { text: WORDS });
    await press(`${SHADOW}.querySelector('.composer .submit')`, 'Post');
    const offered =
      (await poll('the composer to offer sign-in', () =>
        cdp.evaluate(`!!${SHADOW}.querySelector('.composer .auth-signin')`),
      )) === true;
    await press(`${SHADOW}.querySelector('.composer .auth-signin')`, 'Sign in');

    const token = (await poll('the widget to hold a token', () =>
      cdp.evaluate(`localStorage.getItem('cfw:authToken')`),
    )) as string | null;
    const comment = await poll('the comment to reach the server', () => {
      const t = handle?.docStore.listThreads(DOC).find((x) => x.comments[0]?.text === WORDS);
      const c = t?.comments[0];
      return c ? { text: c.text, authorId: c.author.id } : null;
    });
    const boardField = token?.split('.')[4];
    const reading: SignInReading = {
      offered,
      tokenTag: token ? token.slice(0, 4) : null,
      tokenBoard: boardField ? Buffer.from(boardField, 'base64url').toString() : null,
      board,
      comment,
      signedInAs: emailIdentityId(EMAIL),
    };
    cdp.close();
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    page?.stop(true);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
