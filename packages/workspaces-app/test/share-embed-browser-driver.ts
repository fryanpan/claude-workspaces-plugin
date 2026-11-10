#!/usr/bin/env bun
/**
 * A doc with two embed lines, opened by a share-link member on the share
 * hostname in headless Chromium against a real server and the real doc
 * bundle, and by the owner on their own host as the control:
 *
 *   - `::harborlight{block="ferry-map"}` names an allowlisted https origin;
 *   - `::riverbend{block="tide-chart"}` names an app attached to the board,
 *     served by a fixture dev server, so its frame is the board's own app
 *     door `/workspaces/<ws>/apps/<id>/embed/tide-chart/`.
 *
 * The member's page must draw both frames the owner's page draws, and the
 * app's own page must render inside its frame.
 *
 * The share hostname resolves to the test server through Chrome's own
 * host-resolver rules, and the Access token rides on every request as the
 * header Cloudflare would add. The embed origin resolves to nothing, so the
 * frame's own load never leaves the machine — the drawn element is the
 * observable.
 *
 * Spawned by `share-embed-browser.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — every value returned comes from the running page.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  extraChromeArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { accessHarness } from '../../server/test/access-share.ts';

interface Frame {
  src: string | null;
  block: string | null;
}

/** What one reader's page showed. */
export interface EmbedView {
  /** The status the page got for the board's embed mapping. */
  embedsStatus: number;
  /** The frame drawn for the https-origin line, or null when none was. */
  originFrame: (Frame & { origin: string | null }) | null;
  /** The frame drawn for the app line, or null when none was. */
  appFrame: Frame | null;
  /** Whether the fixture app's own page text rendered in any frame. */
  appRendered: boolean;
}

export interface ShareEmbedReading {
  owner: EmbedView;
  member: EmbedView;
  /** Paths the fixture app was asked for, in order. */
  appRequests: string[];
}

const SHARE_AUD = 'aud-share-embed';
const SHARE_HOST = 'share.example.test';
const ORIGIN = 'https://harborlight.example';
const LINE = '::harborlight{block="ferry-map"}';
const APP_LINE = '::riverbend{block="tide-chart"}';
const APP_TEXT = 'Riverbend tide chart';

const step = (what: string): void => {
  process.stderr.write(`[share-embed-driver] ${what}\n`);
};

async function until<T>(what: string, read: () => Promise<T | null>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(100);
  }
  throw new Error(`never happened: ${what}`);
}

let browser: { proc: ChildProcess; profile: string } | undefined;
let fixtureApp: ReturnType<typeof Bun.serve> | undefined;

interface FrameNode {
  frame: { id: string };
  childFrames?: FrameNode[];
}

/** The text of every frame on the page, read in an isolated world each. */
async function frameTexts(cdp: Cdp): Promise<string[]> {
  const { frameTree } = (await cdp.send('Page.getFrameTree')) as { frameTree: FrameNode };
  const ids: string[] = [];
  const walk = (n: FrameNode): void => {
    ids.push(n.frame.id);
    for (const c of n.childFrames ?? []) walk(c);
  };
  walk(frameTree);
  const out: string[] = [];
  for (const frameId of ids) {
    try {
      const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', {
        frameId,
      })) as { executionContextId: number };
      const r = (await cdp.send('Runtime.evaluate', {
        expression: `document.body ? document.body.innerText : ''`,
        contextId: executionContextId,
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      out.push(String(r.result?.value ?? ''));
    } catch {
      out.push('');
    }
  }
  return out;
}

const FRAME_READ = (selector: string): string => `(() => {
  const f = document.querySelector(${JSON.stringify(selector)});
  return f ? { src: f.getAttribute('src'), block: f.dataset.embedBlock ?? null,
               origin: f.dataset.embedOrigin ?? null } : null;
})()`;

async function readView(cdp: Cdp, url: string, ws: string): Promise<EmbedView> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  await until('the doc body', async () =>
    cdp.evaluate(
      `(document.querySelector('#editor')?.textContent ?? '').includes('Riverbend notes') || null`,
    ),
  );
  const embedsStatus = Number(
    await cdp.evaluate(`fetch('/workspaces/${ws}/embeds').then((r) => r.status)`),
  );
  const originFrame = (await until('the origin frame', async () =>
    cdp.evaluate(FRAME_READ('#editor iframe[data-embed-origin]')),
  ).catch(() => null)) as EmbedView['originFrame'];
  const app = (await until('the app frame', async () =>
    cdp.evaluate(FRAME_READ('#editor iframe[data-embed-block="tide-chart"]')),
  ).catch(() => null)) as (Frame & { origin: string | null }) | null;
  const appRendered = await until(
    'the app page rendered',
    async () => (await frameTexts(cdp)).some((t) => t.includes(APP_TEXT)) || null,
  ).catch(() => false);
  return {
    embedsStatus,
    originFrame,
    appFrame: app ? { src: app.src, block: app.block } : null,
    appRendered,
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'share-embed-'));
  let handle: ServerHandle | undefined;
  try {
    step('build the doc bundle');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);

    const access = await accessHarness('alice@example.com');
    const jwt = await access.signJwt(SHARE_AUD);
    const memberHeaders = { 'cf-ray': '8a1b2c3d4e5f-SJC', 'cf-access-jwt-assertion': jwt };

    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'embed-origins.json'), JSON.stringify([ORIGIN]));
    const docPath = join(dir, 'ferry.md');
    writeFileSync(
      docPath,
      `# Harborlight ferry\n\n${LINE}\n\n${APP_LINE}\n\nRiverbend notes below.\n`,
    );
    const appRequests: string[] = [];
    fixtureApp = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (r) => {
        const path = new URL(r.url).pathname;
        appRequests.push(path);
        // The text arrives from the app's own script, as a real app's does,
        // so a frame whose subresources are refused renders nothing.
        if (path.endsWith('/app.js')) {
          return new Response(
            `document.querySelector('h1').textContent = ${JSON.stringify(APP_TEXT)};`,
            { headers: { 'content-type': 'text/javascript' } },
          );
        }
        return new Response(
          '<!doctype html><title>Riverbend</title><h1>loading</h1><script src="app.js"></script>',
          { headers: { 'content-type': 'text/html' } },
        );
      },
    });
    handle = createServer({
      port: 0,
      dataDir,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
      ...access.serverOptions,
      shareLinkHosts: [SHARE_HOST],
      shareLinkAudience: SHARE_AUD,
    });
    const port = handle.port;
    const base = `http://127.0.0.1:${port}`;
    const local = async (method: string, path: string, payload?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        redirect: 'manual',
        headers: { host: `localhost:${port}`, 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const ws = (
      (await local('POST', '/workspaces', { name: 'Harborlight' })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const docId = String(
      (
        await local('POST', `/workspaces/${ws}/docs`, {
          docId: 'ferry',
          type: 'markdown',
          sourceUrl: docPath,
        })
      ).docId,
    );
    await local('POST', `/workspaces/${ws}/docs:attach`, { docId });
    const appDocId = String(
      (
        await local('POST', `/workspaces/${ws}/apps`, {
          docId: 'riverbend',
          origin: `http://127.0.0.1:${fixtureApp.port}/`,
          title: 'Riverbend',
        })
      ).docId,
    );
    await local('PUT', `/workspaces/${ws}/embeds`, {
      embeds: {
        harborlight: { origin: ORIGIN, pathTemplate: '{origin}/embed/{block}/' },
        riverbend: { appDocId, pathTemplate: '{mount}/embed/{block}/' },
      },
    });
    handle.shareLinks.addToAudience(ws, ['@example.com'], 'Harborlight');
    const minted = (await local('POST', '/api/share/workspace', {
      workspaceId: ws,
      landing: { kind: 'doc', id: docId },
    })) as { link: { linkId: string } };
    const redeemed = await fetch(`${base}/s/${minted.link.linkId}`, {
      redirect: 'manual',
      headers: { host: SHARE_HOST, ...memberHeaders },
    });
    if (redeemed.status !== 302) throw new Error(`redeem: ${redeemed.status}`);

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) =>
        chromeLaunchArgs({ width: 1180, height: 820 }, profile, [
          ...extraChromeArgs(),
          `--host-resolver-rules=MAP ${SHARE_HOST} 127.0.0.1, MAP harborlight.example ~NOTFOUND`,
          // Every frame in one renderer, so the frame tree below reaches them all.
          '--disable-site-isolation-trials',
          '--disable-features=IsolateOrigins,site-per-process',
        ]),
      STARTUP_TIMEOUT_MS,
      `share-embed-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
    });
    const docPage = `/workspaces/${ws}/docs/${docId}`;
    step('open the doc as the owner, on their own host');
    const owner = await readView(cdp, `http://127.0.0.1:${port}${docPage}`, ws);
    await cdp.send('Network.setExtraHTTPHeaders', { headers: memberHeaders });
    step('open the doc as a member, on the share hostname');
    const member = await readView(cdp, `http://${SHARE_HOST}:${port}${docPage}`, ws);
    cdp.close();
    const reading: ShareEmbedReading = { owner, member, appRequests };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    fixtureApp?.stop(true);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 170s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 170_000).unref();
await main();
process.exit(0);
