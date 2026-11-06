#!/usr/bin/env bun
/**
 * A page on another port of the board's tailnet host signs in through the
 * widget and posts a comment, in a running browser.
 *
 * Laid out as the deployment is, over TLS, so every origin the browser reads
 * is the real shape: `https://<tailnet host>` is `tailscale serve` in front of
 * the board, `https://<tailnet host>:10000` is the dev page, and
 * `https://<operator host>` is the Cloudflare edge in front of the same board,
 * adding the Access assertion a signed-in person's request carries. Chromium's
 * resolver rules send all three to local listeners, so no real name is used.
 *
 * Spawned by `packages/widget/test/widget-tailnet-sign-in-browser.test.ts`, which reads the JSON
 * this prints on its last line.
 *
 * The one file it reads is the certificate it just wrote. Nothing here reads a
 * source file, a bundle or a stylesheet; every value it returns was measured
 * in a running browser or read off the server's own store.
 */
// audit: no-text
import { type ChildProcess, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { type Server, connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as tlsServer } from 'node:tls';
import { emailIdentityId } from '@claude-workspaces/core';
import { type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { Cdp, launchChrome, pageSocketUrl, stopBrowser } from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';
import { waitFor } from './wait-for.ts';

const TAG = 'claude-feedback-widget';
const SHADOW = `document.querySelector('${TAG}').shadowRoot`;
const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const AUD = 'aud-for-the-operator-app';
const KID = 'tailnet-sign-in-kid';
const EMAIL = 'operator@example.com';
/** The board's tailnet name. Invented: the repo is public. */
const TAILNET_HOST = 'riverbend-host.tailnet-name.test';
const OPERATOR_HOST = 'operator.example.com';
const PAGE_PORT = 10000;
const PAGE_ORIGIN = `https://${TAILNET_HOST}:${PAGE_PORT}`;
const DOC = 'harborlight-insights';
const WORDS = 'the third chart has no axis labels';
/** `app`: the page's doc id is an attached dev server. Otherwise the widget's
 *  first socket makes the doc. */
const ATTACHED_APP = process.argv[2] === 'app';

export interface TailnetSignInReading {
  /** The origin the page ran on, read in the page. */
  pageOrigin: string;
  /** The composer offered sign-in. */
  offered: boolean;
  /** The origin the sign-in popup opened on. */
  popupOrigin: string | null;
  /** What the board token the widget stored was minted for, or null. */
  tokenOrigin: string | null;
  tokenBoard: string | null;
  board: string;
  comment: { text: string; authorId: string } | null;
  signedInAs: string;
  /** Every request the page made to the board, in order. */
  requests: string[];
  /** What the browser said about them. */
  console: string[];
  pages: string[];
}

async function buildWidget(dist: string): Promise<void> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dirname, '../../widget/src/widget-iife.ts')],
    outdir: dist,
    target: 'browser',
    format: 'iife',
    naming: '[name].js',
  });
  if (!built.success) throw new Error(`widget build failed: ${built.logs.join('\n')}`);
  renameSync(join(dist, 'widget-iife.js'), join(dist, 'widget.iife.js'));
}

/** One throwaway certificate, in its own directory. Written to files because
 *  openssl on Linux cannot reopen `/dev/stdout` when stdout is a pipe. */
function selfSigned(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), 'widget-tailnet-tls-'));
  try {
    const key = join(dir, 'edge.key');
    const cert = join(dir, 'edge.crt');
    execFileSync(
      'openssl',
      'req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=edge'
        .split(' ')
        .concat(['-keyout', key, '-out', cert]),
      { stdio: 'ignore' },
    );
    return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `tailscale serve`: TLS on the tailnet name, bytes through to a local port. */
async function tlsFront(tls: { key: string; cert: string }, to: number): Promise<Server> {
  const server = tlsServer(tls, (socket) => {
    const upstream = netConnect(to, '127.0.0.1');
    socket.pipe(upstream).pipe(socket);
    for (const s of [socket, upstream]) s.on('error', () => s.destroy());
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

const portOf = (s: Server): number => (s.address() as { port: number }).port;

function pageHtml(board: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:15px/1.5 system-ui;margin:0} header{padding:24px} main{padding:160px 24px}</style>
</head><body>
<header><h1 id="title">Harborlight insights</h1></header>
<main><p id="chart">Sailings per week, Riverbend to Saltmarsh.</p></main>
<${TAG} doc-id="${DOC}" workspace-id="${board}" user="Alice"></${TAG}>
<script src="https://${TAILNET_HOST}/widget.iife.js"></script>
</body></html>`;
}

/** The value `read` comes to, or null with the reason on stderr: a step that
 *  never happens is a reading, and the run goes on to report the rest. */
async function poll<T>(what: string, read: () => Promise<T | null> | T | null): Promise<T | null> {
  return waitFor(read, { timeout: 10_000, interval: 100, describe: what }).catch(() => {
    process.stderr.write(`never happened: ${what}\n`);
    return null;
  });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'widget-tailnet-sign-in-'));
  let handle: ServerHandle | undefined;
  let page: ReturnType<typeof Bun.serve> | undefined;
  let edge: ReturnType<typeof Bun.serve> | undefined;
  const fronts: Server[] = [];
  let browser: { proc: ChildProcess; profile: string } | undefined;
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = (await exportJWK(publicKey)) as JWK;
    Object.assign(publicJwk, { kid: KID, alg: 'RS256', use: 'sig' });
    const jwt = await new SignJWT({ email: EMAIL })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-operator')
      .sign(privateKey);

    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: AUD, jwks: { keys: [publicJwk] } },
      proxiedTrustedHosts: [OPERATOR_HOST],
      proxiedTrustedEmails: [EMAIL],
      widgetDoorHosts: [TAILNET_HOST],
    });
    const serverPort = handle.port;
    const board = handle.tasks.createWorkspace('Harborlight').id;
    page = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(pageHtml(board), { headers: { 'content-type': 'text/html' } }),
    });

    if (ATTACHED_APP) {
      const attached = await fetch(`http://127.0.0.1:${serverPort}/workspaces/${board}/apps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: DOC, origin: `http://127.0.0.1:${page.port}` }),
      });
      if (!attached.ok) throw new Error(`attach_app failed: ${attached.status}`);
    }
    const tls = selfSigned();
    // The Cloudflare edge for the operator's host: the person is signed in to
    // Access, so every request arrives with the assertion and a `cf-ray`.
    edge = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls,
      fetch: (req) => {
        const url = new URL(req.url);
        const headers = new Headers(req.headers);
        headers.set('host', OPERATOR_HOST);
        headers.set('cf-ray', '8a1b2c3d4e5f-SJC');
        headers.set('x-forwarded-proto', 'https');
        headers.set('cf-access-jwt-assertion', jwt);
        // fetch inflates what it reads, and would hand the browser the header
        // saying the body is still compressed.
        headers.set('accept-encoding', 'identity');
        return fetch(`http://127.0.0.1:${serverPort}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          redirect: 'manual',
          ...(req.method === 'GET' ? {} : { body: req.body }),
        });
      },
    });
    const serve = await tlsFront(tls, serverPort);
    const pageFront = await tlsFront(tls, page.port as number);
    fronts.push(serve, pageFront);

    const rules = [
      `MAP ${TAILNET_HOST}:443 127.0.0.1:${portOf(serve)}`,
      `MAP ${TAILNET_HOST}:${PAGE_PORT} 127.0.0.1:${portOf(pageFront)}`,
      `MAP ${OPERATOR_HOST}:443 127.0.0.1:${edge.port}`,
    ].join(',');
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) =>
        chromeLaunchArgs({ width: 1180, height: 820 }, profile, [
          `--host-resolver-rules=${rules}`,
          '--ignore-certificate-errors',
        ]),
      STARTUP_TIMEOUT_MS,
      `widget-tailnet-sign-in-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');

    const requests: string[] = [];
    const consoleLines: string[] = [];
    const short = (u: string) => u.replace(`https://${TAILNET_HOST}`, '').split('?')[0] ?? u;
    const methods = new Map<string, string>();
    cdp.on('Network.requestWillBeSent', (p) => {
      const q = p as { requestId: string; request: { method: string; url: string } };
      methods.set(q.requestId, q.request.method);
    });
    cdp.on('Network.responseReceived', (p) => {
      const q = p as { requestId: string; response: { url: string; status: number } };
      requests.push(`${methods.get(q.requestId)} ${short(q.response.url)} ${q.response.status}`);
    });
    cdp.on('Network.loadingFailed', (p) => {
      const q = p as { requestId: string; errorText: string; blockedReason?: string };
      requests.push(`failed ${methods.get(q.requestId)} ${q.errorText} ${q.blockedReason ?? ''}`);
    });
    cdp.on('Network.webSocketHandshakeResponseReceived', (p) => {
      const q = p as { response: { status: number } };
      requests.push(`socket ${q.response.status}`);
    });
    cdp.on('Network.webSocketFrameError', (p) => {
      requests.push(`socket error ${(p as { errorMessage: string }).errorMessage}`);
    });
    cdp.on('Log.entryAdded', (p) => {
      consoleLines.push((p as { entry: { text: string } }).entry.text);
    });

    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${PAGE_ORIGIN}/insights` });
    await loaded;
    const pageOrigin = (await cdp.evaluate('location.origin')) as string;

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
    await press(`document.getElementById('chart')`, 'the paragraph');
    await poll('the composer', () =>
      cdp.evaluate(`!!${SHADOW}.querySelector('.composer textarea')`),
    );
    await cdp.evaluate(`${SHADOW}.querySelector('.composer textarea').focus()`);
    await cdp.send('Input.insertText', { text: WORDS });
    const offered =
      (await poll('the composer to offer sign-in', () =>
        cdp.evaluate(`!!${SHADOW}.querySelector('.composer .auth-signin')`),
      )) === true;
    // A popup that closes at once leaves no page to read, so catch its URL as
    // it opens rather than listing the browser's pages afterwards.
    const popups: string[] = [];
    cdp.on('Page.windowOpen', (p) => popups.push((p as { url: string }).url));
    await press(`${SHADOW}.querySelector('.composer .auth-signin')`, 'Sign in');

    const token = (await poll('the widget to hold a token', () =>
      cdp.evaluate(`localStorage.getItem('cfw:authToken')`),
    )) as string | null;
    const comment = await poll('the comment to reach the server', () => {
      const t = handle?.docStore.listThreads(DOC).find((x) => x.comments[0]?.text === WORDS);
      const c = t?.comments[0];
      return c ? { text: c.text, authorId: c.author.id } : null;
    });
    const list = (await (await fetch(`http://127.0.0.1:${b.port}/json/list`)).json()) as Array<{
      type: string;
      url: string;
      webSocketDebuggerUrl?: string;
    }>;
    const open: string[] = [];
    for (const t of list.filter((x) => x.type === 'page')) {
      let status = '';
      if (t.url.includes('/widget-auth') && t.webSocketDebuggerUrl) {
        const sheet = await Cdp.connect(t.webSocketDebuggerUrl);
        status = String(await sheet.evaluate('document.body?.innerText ?? ""'));
        sheet.close();
      }
      open.push(status ? `${t.url} says: ${status}` : t.url);
    }
    const fields = token?.split('.') ?? [];
    const decode = (v?: string) => (v ? Buffer.from(v, 'base64url').toString() : null);
    const popup = popups[0] ? new URL(popups[0]).origin : null;
    const reading: TailnetSignInReading = {
      pageOrigin,
      offered,
      popupOrigin: popup,
      tokenOrigin: decode(fields[5]),
      tokenBoard: decode(fields[4]),
      board,
      comment,
      signedInAs: emailIdentityId(EMAIL),
      requests,
      console: consoleLines,
      pages: open,
    };
    cdp.close();
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    for (const f of fronts) f.close();
    edge?.stop(true);
    page?.stop(true);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
