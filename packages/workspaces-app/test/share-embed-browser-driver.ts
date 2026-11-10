#!/usr/bin/env bun
/**
 * A doc with a `::harborlight{block="ferry-map"}` line, opened by a share-link
 * member on the share hostname in headless Chromium against a real server and
 * the real doc bundle. The board's embed mapping names an allowlisted https
 * origin; the member's page must draw the frame the owner's page draws.
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

export interface ShareEmbedReading {
  /** The status the member's page got for the board's embed mapping. */
  embedsStatus: number;
  /** The frame the doc drew for the directive, or null when it drew none. */
  frame: { src: string | null; origin: string | null; block: string | null } | null;
}

const SHARE_AUD = 'aud-share-embed';
const SHARE_HOST = 'share.example.test';
const ORIGIN = 'https://harborlight.example';
const LINE = '::harborlight{block="ferry-map"}';

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
    writeFileSync(docPath, `# Harborlight ferry\n\n${LINE}\n\nRiverbend notes below.\n`);
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
    await local('PUT', `/workspaces/${ws}/embeds`, {
      embeds: { harborlight: { origin: ORIGIN, pathTemplate: '{origin}/embed/{block}/' } },
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
    await cdp.send('Network.setExtraHTTPHeaders', { headers: memberHeaders });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
    });
    step('open the doc as a member, on the share hostname');
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', {
      url: `http://${SHARE_HOST}:${port}/workspaces/${ws}/docs/${docId}`,
    });
    await loaded;
    await until('the doc body', async () =>
      cdp.evaluate(
        `(document.querySelector('#editor')?.textContent ?? '').includes('Riverbend') || null`,
      ),
    );
    const embedsStatus = Number(
      await cdp.evaluate(`fetch('/workspaces/${ws}/embeds').then((r) => r.status)`),
    );
    const frame = (await until('the embed frame', async () =>
      cdp.evaluate(`(() => {
        const f = document.querySelector('#editor iframe[data-embed-origin]');
        return f ? { src: f.getAttribute('src'), origin: f.dataset.embedOrigin ?? null,
                     block: f.dataset.embedBlock ?? null } : null;
      })()`),
    ).catch(() => null)) as ShareEmbedReading['frame'];
    cdp.close();
    const reading: ShareEmbedReading = { embedsStatus, frame };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
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
