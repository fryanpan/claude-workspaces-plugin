#!/usr/bin/env bun
/**
 * Archiving a doc with a stale sign-in, in headless Chromium against a real
 * board server: refused, signed in again, then archived and put back.
 *
 * The server sits behind a stand-in for Cloudflare Access on loopback. The
 * stand-in turns the `CF_Authorization` cookie into the assertion header and
 * adds `cf-ray`, as the edge does, and proxies the doc's websocket the same
 * way. A request with no cookie is sent to its login path, which mints a
 * token with `iat` = now and sends the browser back: what Access does for a
 * person whose identity provider's session is still open. The browser starts
 * holding a token minted twenty minutes ago.
 *
 * The host is `workspaces.localhost`, which Chrome treats as a secure
 * context, so the `Secure` cookie the server clears it with is honoured over
 * plain http as it is over TLS.
 *
 * Spawned by `packages/workspaces-app/test/fresh-signin-browser.test.ts`, which reads the JSON this prints
 * on its last line. Screenshots go to `$FRESH_SIGNIN_SHOTS` when it is set.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was measured in the running page or read
 * off the server.
 */
import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  Cdp,
  launchChrome,
  pageSocketUrl,
  stopBrowser,
  withTimeout,
} from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'fresh-signin-browser-kid';
const AUD = 'aud-for-the-owner-app';
const HOST = 'workspaces.localhost';
const OWNER_EMAIL = 'owner@harborlight.test';
const LOGIN = '/cdn-cgi/access/login';
const STALE_SECONDS = 20 * 60;

/** One dialog as the page showed it. */
export interface Asked {
  title: string;
  buttons: string[];
}

/** One element's box, in CSS pixels. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  height: number;
}

export interface FreshSignInReading {
  /** The first tap, with the stale token: what was asked. */
  firstAsk: Asked | null;
  /** Whether the doc was still on the board while that was asked. */
  onBoardWhileAsked: boolean;
  /** Cancel: the toast, and whether the doc stayed. */
  cancelToast: string;
  onBoardAfterCancel: boolean;
  /** "Sign in again" → "Go to sign-in": the second card. */
  secondAsk: Asked | null;
  /** Tokens the stand-in minted on the way back: one sign-in. */
  minted: number;
  /** The path the page came back to. */
  backAt: string;
  /** What the page asked on its return, and whether the doc was still there. */
  resumeAsk: Asked | null;
  onBoardBeforeResume: boolean;
  /** After confirming: the toast, its button, the board, the bar. */
  archivedToast: string;
  archivedToastAction: string;
  onBoardAfterArchive: boolean;
  barShown: boolean;
  /** "Put it back" on the toast: no dialog, back on the board, bar gone. */
  askedOnPutBack: boolean;
  onBoardAfterPutBack: boolean;
  barAfterPutBack: boolean;
  /** At 430 wide, a stale token again. */
  narrow: {
    viewport: { width: number; height: number };
    more: Box | null;
    menu: Box | null;
    ask: Asked | null;
    askButtons: Box[];
    /** An agent archives the doc over loopback: the open page's bar. */
    liveBar: Box | null;
    /** The agent was not asked. */
    agentStatus: number;
  };
  /** At 1180x820: the dialog's buttons. */
  wideAskButtons: Box[];
  /** Page exceptions over the run. */
  errors: string[];
}

const step = (what: string): void => {
  process.stderr.write(`[fresh-signin-browser-driver] ${what}\n`);
};

interface Tunnel {
  backend: WebSocket;
  queue: Array<string | Uint8Array>;
}

/** A stand-in for Access in front of one server, websockets included. */
function edgeFor(server: ServerHandle, mint: () => Promise<string>) {
  const counts = { minted: 0 };
  const backendHttp = `http://127.0.0.1:${server.port}`;
  const backendWs = `ws://127.0.0.1:${server.port}`;
  const s = Bun.serve<{ url: string; headers: Record<string, string>; tunnel?: Tunnel }>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === LOGIN) {
        counts.minted++;
        const back = url.searchParams.get('redirect_url') ?? '/';
        return new Response(null, {
          status: 302,
          headers: {
            location: back.startsWith('/') ? back : '/',
            'set-cookie': `CF_Authorization=${await mint()}; Path=/; HttpOnly; SameSite=Lax`,
          },
        });
      }
      const cookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get('cookie') ?? '');
      if (!cookie?.[1]) {
        // Only a navigation is sent to sign in. Access's own session cookie
        // lives on the team domain, so a fetch or a credential-less load
        // (the manifest) gets no token minted for it.
        if (req.headers.get('sec-fetch-mode') !== 'navigate') {
          return new Response('Access: sign in', { status: 403 });
        }
        const back = `${url.pathname}${url.search}`;
        return new Response(null, {
          status: 302,
          headers: { location: `${LOGIN}?redirect_url=${encodeURIComponent(back)}` },
        });
      }
      const forwarded: Record<string, string> = {
        'cf-access-jwt-assertion': cookie[1],
        'cf-ray': '8a1b2c3d4e5f-SJC',
        host: url.host,
      };
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const origin = req.headers.get('origin');
        if (origin) forwarded.origin = origin;
        const ok = srv.upgrade(req, {
          data: { url: `${backendWs}${url.pathname}${url.search}`, headers: forwarded },
        });
        return ok ? undefined : new Response('upgrade failed', { status: 400 });
      }
      const headers = new Headers(req.headers);
      headers.delete('cookie');
      // Uncompressed: `fetch` would inflate the body and pass on the
      // compressed length, and the browser would wait for the missing bytes.
      // Deleting the header is not enough; `fetch` then adds its own.
      headers.set('accept-encoding', 'identity');
      for (const [k, v] of Object.entries(forwarded)) headers.set(k, v);
      return fetch(`${backendHttp}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
        redirect: 'manual',
      });
    },
    websocket: {
      open(ws: ServerWebSocket<{ url: string; headers: Record<string, string>; tunnel?: Tunnel }>) {
        const backend = new WebSocket(ws.data.url, { headers: ws.data.headers } as never);
        backend.binaryType = 'arraybuffer';
        const tunnel: Tunnel = { backend, queue: [] };
        ws.data.tunnel = tunnel;
        backend.addEventListener('open', () => {
          for (const m of tunnel.queue) backend.send(m);
          tunnel.queue = [];
        });
        backend.addEventListener('message', (e) => {
          ws.send(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
        });
        backend.addEventListener('close', (e) => {
          // The reason is the live path: "doc archived" reaches the page.
          ws.close(e.code === 1005 || e.code === 1006 ? 1000 : e.code, e.reason);
        });
      },
      message(ws, msg) {
        const t = ws.data.tunnel;
        if (!t) return;
        const m = typeof msg === 'string' ? msg : new Uint8Array(msg);
        if (t.backend.readyState === WebSocket.OPEN) t.backend.send(m);
        else t.queue.push(m);
      },
      close(ws) {
        ws.data.tunnel?.backend.close();
      },
    },
  });
  return { port: s.port as number, stop: () => s.stop(true), counts };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fresh-signin-browser-'));
  const shots = process.env.FRESH_SIGNIN_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let handle: ServerHandle | undefined;
  let edge: ReturnType<typeof edgeFor> | undefined;
  let browser: { proc: ChildProcess; profile: string } | undefined;
  try {
    step('build the board client');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      [
        'run',
        join(import.meta.dirname, '../../workspaces-app/scripts/build.ts'),
        '--outdir',
        appDist,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`board client build failed:\n${built.stderr}`);

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = (await exportJWK(publicKey)) as JWK;
    Object.assign(jwk, { kid: KID, alg: 'RS256', use: 'sig' });
    const jwks: JSONWebKeySet = { keys: [jwk] };
    const token = (ageSeconds: number) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ email: OWNER_EMAIL })
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(AUD)
        .setIssuedAt(now - ageSeconds)
        .setExpirationTime(now + 3600)
        .sign(privateKey);
    };

    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      markdownAppDistDir: appDist,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: AUD, jwks },
      // A sharing surface, so loopback stays the agents' unauthenticated
      // door rather than the whole server sitting behind Access.
      shareLinkHosts: ['share.localhost'],
      shareLinkAudience: 'aud-for-the-share-app',
      proxiedTrustedHosts: [HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      requireSignInToWrite: false,
    });
    const local = `http://127.0.0.1:${handle.port}`;
    const agentPost = (path: string, body: unknown) =>
      fetch(`${local}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const board = handle.tasks.createWorkspace('Harborlight').id;
    const docId = 'riverbend-launch-notes';
    const file = join(dir, `${docId}.md`);
    writeFileSync(file, '# Riverbend launch notes\n\nThe launch is on Thursday.\n');
    for (const [path, body] of [
      [`/workspaces/${board}/docs`, { docId, type: 'markdown', sourceUrl: file }],
      [`/workspaces/${board}/docs:attach`, { docId }],
    ] as const) {
      const r = await agentPost(path, body);
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    }
    const onBoard = async () =>
      (await fetch(`${local}/workspaces/${board}/docs/${docId}?format=json`)).status === 200;

    edge = edgeFor(handle, () => token(0));
    const site = `http://${HOST}:${edge.port}`;
    const pagePath = `/workspaces/${board}/docs/${docId}`;

    step('launch Chrome');
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `fresh-signin-browser-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    const errors: string[] = [];
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = (p as { exceptionDetails?: { exception?: { description?: string } } })
        .exceptionDetails;
      errors.push(d?.exception?.description?.split('\n')[0] ?? 'exception');
    });
    const viewport = async (width: number, height: number) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    };
    const staleCookie = async () => {
      await cdp.send('Network.setCookie', {
        name: 'CF_Authorization',
        value: await token(STALE_SECONDS),
        url: site,
        httpOnly: true,
        sameSite: 'Lax',
      });
    };
    const ev = <T>(expr: string) => cdp.evaluate(expr) as Promise<T>;
    const poll = <T>(what: string, expr: string, timeout = 20_000): Promise<T> =>
      waitFor(() => ev<T>(expr).catch(() => null), { timeout, describe: what }) as Promise<T>;
    const pollServer = (what: string, want: boolean) =>
      waitFor(async () => (await onBoard()) === want, { timeout: 10_000, describe: what });
    const open = async () => {
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `${site}${pagePath}` });
      await withTimeout(loaded, 30_000, 'the doc page to load');
      await poll('the More button', `!document.getElementById('doc-more')?.hidden`);
    };
    const shot = async (name: string) => {
      if (!shots) return;
      const r = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
      writeFileSync(join(shots, `${name}.png`), Buffer.from(r.data, 'base64'));
    };
    const ASKED = `(() => {
      const c = document.querySelector('.fresh-signin-prompt .identity-card');
      if (!c) return null;
      return { title: c.querySelector('h2')?.textContent ?? '',
        buttons: [...c.querySelectorAll('button')].map((b) => b.textContent ?? '') };
    })()`;
    const BUTTON_BOXES = `[...document.querySelectorAll('.fresh-signin-prompt button')].map((b) => {
      const r = b.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height };
    })`;
    const box = (sel: string) => `(() => {
      const e = document.querySelector(${JSON.stringify(sel)});
      if (!e || e.offsetWidth === 0) return null;
      const r = e.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height };
    })()`;
    const askedTitled = (title: string) =>
      poll<Asked>(
        `the "${title}" card`,
        `(() => { const a = ${ASKED}; return a && a.title === ${JSON.stringify(title)} ? a : null; })()`,
      );
    const press = (label: string) =>
      ev(`(() => {
        const b = [...document.querySelectorAll('.fresh-signin-prompt button')]
          .find((x) => x.textContent === ${JSON.stringify(label)});
        if (!b) throw new Error('no button ' + ${JSON.stringify(label)});
        b.click(); return true;
      })()`);
    const tapArchive = () =>
      ev(`(() => { document.getElementById('doc-more').click();
        document.getElementById('menu-archive').click(); return true; })()`);
    const toastText = (contains: string) =>
      poll<string>(
        `a toast with "${contains}"`,
        `(() => { const t = document.getElementById('toast');
          return t && !t.classList.contains('hidden') && t.textContent.includes(${JSON.stringify(contains)})
            ? t.textContent : null; })()`,
      );
    const barShown = () => ev<boolean>(`!document.getElementById('archived-bar').hidden`);

    step('open the doc with a token minted twenty minutes ago');
    await viewport(1180, 820);
    await staleCookie();
    await open();

    step('tap Archive, then Cancel');
    await tapArchive();
    const firstAsk = await askedTitled("Confirm it's you");
    const onBoardWhileAsked = await onBoard();
    await press('Cancel');
    const cancelToast = await toastText('Nothing changed');
    const onBoardAfterCancel = await onBoard();

    step('tap Archive, then Sign in again');
    await tapArchive();
    await askedTitled("Confirm it's you");
    const wideAskButtons = await ev<Box[]>(BUTTON_BOXES);
    await shot('wide-confirm');
    await press('Sign in again');
    const secondAsk = await askedTitled('Sign in again');
    const mintedBefore = edge.counts.minted;
    const back = cdp.once('Page.loadEventFired');
    await press('Go to sign-in');
    await back;
    const resumeAsk = await poll<Asked>(
      'the resume card',
      `(() => { const a = ${ASKED}; return a && a.title.endsWith(' now?') ? a : null; })()`,
    );
    const minted = edge.counts.minted - mintedBefore;
    const backAt = await ev<string>('location.pathname');
    const onBoardBeforeResume = await onBoard();
    await shot('wide-resume');

    step('confirm the archive');
    await press('Archive');
    const archivedToast = await toastText('Archived');
    const archivedToastAction = await ev<string>(
      `document.querySelector('#toast .toast-action')?.textContent ?? ''`,
    );
    await pollServer('the archive', false);
    const onBoardAfterArchive = await onBoard();
    const barAfterArchive = await barShown();
    await shot('wide-archived');

    step('Put it back');
    await ev(`(() => { document.querySelector('#toast .toast-action').click(); return true; })()`);
    await pollServer('the unarchive', true);
    await poll('the bar to go', `document.getElementById('archived-bar').hidden`);
    const askedOnPutBack = (await ev<Asked | null>(ASKED)) !== null;
    const onBoardAfterPutBack = await onBoard();
    const barAfterPutBack = await barShown();

    step('430 wide, a stale token again');
    await viewport(430, 932);
    await staleCookie();
    await open();
    const more = await ev<Box | null>(box('#doc-more'));
    await ev(`(() => { document.getElementById('doc-more').click(); return true; })()`);
    const menu = await poll<Box>('the More menu', box('#more-menu'));
    await ev(`(() => { document.getElementById('menu-archive').click(); return true; })()`);
    const narrowAsk = await askedTitled("Confirm it's you");
    const askButtons = await ev<Box[]>(BUTTON_BOXES);
    await shot('narrow-confirm');
    await press('Cancel');
    await toastText('Nothing changed');

    step('an agent archives the doc while the page is open');
    const agentRes = await agentPost(`/workspaces/${board}/docs/${docId}/archive`, {});
    const liveBar = await poll<Box>('the archived bar', box('#archived-bar'));
    await shot('narrow-archived');
    await agentPost(`/workspaces/${board}/docs/${docId}/unarchive`, {});

    cdp.close();
    const reading: FreshSignInReading = {
      firstAsk,
      onBoardWhileAsked,
      cancelToast,
      onBoardAfterCancel,
      secondAsk,
      minted,
      backAt,
      resumeAsk,
      onBoardBeforeResume,
      archivedToast,
      archivedToastAction,
      onBoardAfterArchive,
      barShown: barAfterArchive,
      askedOnPutBack,
      onBoardAfterPutBack,
      barAfterPutBack,
      narrow: {
        viewport: { width: 430, height: 932 },
        more,
        menu,
        ask: narrowAsk,
        askButtons,
        liveBar,
        agentStatus: agentRes.status,
      },
      wideAskButtons,
      errors,
    };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    edge?.stop();
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
