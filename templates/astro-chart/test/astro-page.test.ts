/**
 * The library chart runs unchanged on an Astro page: this fixture's page
 * imports `core/plot-chart.ts` itself, the file the doc test draws in a doc
 * (`packages/workspaces-app/test/plot-chart-doc-browser.test.ts`), and mounts
 * it with a hook over a JSON snapshot of its state. Built with Astro and
 * opened in headless Chromium, the page shows the snapshot's rows and title
 * over the props the page wrote.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromeForSuite } from '../../../scripts/browser-tests.ts';
import {
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
  stopBrowser,
} from '../../../scripts/headless-chrome.ts';
import { STARTUP_TIMEOUT_MS, chromeLaunchArgs } from '../../../scripts/ui-shot-lib.ts';

/** The browser these cases may launch, or null to skip them.
 *  The gate, and why it defaults off, is `scripts/browser-tests.ts`. */
const CHROME = chromeForSuite();

const FIXTURE = join(import.meta.dirname, '..');
const SUITE_MS = 180_000;
const CASE_MS = 60_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const READ = `(() => {
  const figure = document.querySelector('#ferry figure.plot-chart');
  const bars = figure ? figure.querySelectorAll('[aria-label="bar"] rect').length : 0;
  if (!figure || bars === 0) return null;
  return {
    bars,
    title: figure.querySelector('.plot-chart-title')?.textContent ?? '',
    towns: [...figure.querySelectorAll('[aria-label="x-axis tick label"] text')].map((t) => t.textContent),
  };
})()`;

interface PageReading {
  bars: number;
  title: string;
  towns: string[];
}

let dir = '';
let server: Server | undefined;
let browser: { proc: import('node:child_process').ChildProcess; profile: string } | undefined;
let reading: PageReading;

describe.skipIf(CHROME === null)('the library chart on an Astro page', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'astro-chart-'));
    const out = join(dir, 'dist');
    const built = spawnSync(
      process.execPath,
      [join(FIXTURE, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'build', '--outDir', out],
      {
        cwd: FIXTURE,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
      },
    );
    expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);

    server = createServer((req, res) => {
      const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'));
      const file = join(out, path.endsWith('/') ? `${path}index.html` : path);
      if (!file.startsWith(out)) {
        res.writeHead(404).end();
        return;
      }
      readFile(file).then(
        (body) =>
          res
            .writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
            .end(body),
        () => res.writeHead(404).end(),
      );
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const b = await launchChrome(
      CHROME as string,
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `astro-chart-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    try {
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
      await loaded;
      const end = Date.now() + 30_000;
      let got: PageReading | null = null;
      while (!got && Date.now() < end) {
        got = (await cdp.evaluate(READ)) as PageReading | null;
        if (!got) await sleep(50);
      }
      if (!got) throw new Error('the chart never drew on the Astro page');
      reading = got;
    } finally {
      cdp.close();
    }
  }, SUITE_MS);

  afterAll(async () => {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it(
    "draws the snapshot's rows over the page's props",
    () => {
      expect(reading.bars).toBe(3);
      expect(reading.towns).toEqual(['Harborlight', 'Riverbend', 'Saltmarsh']);
    },
    CASE_MS,
  );

  it(
    "shows the snapshot's title in place of the page's",
    () => {
      expect(reading.title).toBe("Ferry trips, from the doc's state");
    },
    CASE_MS,
  );
});
