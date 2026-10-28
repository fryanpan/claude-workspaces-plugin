#!/usr/bin/env bun
/**
 * Every page type posts its load report, in headless Chromium against a real
 * server and the real bundles.
 *
 * Boots a server with one board holding a doc, a mock, a diff review and a
 * bound folder, then opens each page type in turn — the board, Home, the
 * review page, the doc, the mock, a diff file and a folder file — and after
 * each one waits for the server's slowest-load read
 * (`GET /api/load-reports/slowest`) to count a load of that page type. What
 * it reads there is what the server stored, so a report that was sent to the
 * wrong route, refused, or filed under the wrong page type does not count.
 *
 * Spawned by `page-load-report-browser.test.ts`, which reads the JSON this
 * prints last.
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
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import type { SlowestByPage } from '../../server/src/page-loads.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';

export interface PageLoadRun {
  /** Loads the server counted for each page type, after that page was opened. */
  loads: Record<string, number>;
  /** Whether each counted load carried a content time (it arrived). */
  arrived: Record<string, boolean>;
}

const step = (what: string): void => {
  process.stderr.write(`[page-load-driver] ${what}\n`);
};

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'page-load-report-'));
  let handle: ServerHandle | undefined;
  try {
    step('build the widget and the app');
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`app build failed:\n${built.stderr}`);

    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, payload: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };

    step('seed a board with a doc, a mock, a diff and a folder');
    const ws = (
      (await post('/workspaces', { name: 'Harborlight' })) as { workspace: { id: string } }
    ).workspace.id;
    const docFile = join(dir, 'tides.md');
    writeFileSync(docFile, '# Riverbend tides\n\nThe Saltmarsh slipway floods at noon.\n');
    const docId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'tides',
          type: 'markdown',
          sourceUrl: docFile,
        })
      ).docId,
    );
    const mockFile = join(dir, 'moorings.html');
    writeFileSync(
      mockFile,
      '<!doctype html><html><head><title>Moorings</title></head><body><h1>Moorings</h1></body></html>',
    );
    const mockId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'moorings',
          type: 'mockup',
          sourceUrl: mockFile,
        })
      ).docId,
    );
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        // No address at all: the fixture commits need a name, not an email.
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: '',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: '',
        },
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'ferry.ts'), 'export const berths = 2;\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    writeFileSync(join(repo, 'ferry.ts'), 'export const berths = 3;\n');
    const diff = (await post(`/workspaces/${ws}/attachments`, { repo, base: 'main' })) as {
      files: Array<{ docId: string }>;
    };
    const diffDoc = diff.files[0]?.docId;
    const folder = join(dir, 'folder');
    mkdirSync(folder);
    writeFileSync(join(folder, 'notes.md'), '# Saltmarsh notes\n\nHigh water at six.\n');
    const bound = (await post('/workspaces', { folderPath: folder, hubWorkspaceId: ws })) as {
      files: Array<{ docId: string }>;
    };
    const folderDoc = bound.files[0]?.docId;
    if (!diffDoc || !folderDoc) throw new Error('the diff or the folder bound no file');

    const pages: Array<[string, string]> = [
      ['board', `/workspaces/${ws}`],
      ['home', '/'],
      ['review', '/review'],
      ['doc', `/workspaces/${ws}/docs/${encodeURIComponent(docId)}`],
      ['mock', `/workspaces/${ws}/mockups/${encodeURIComponent(mockId)}`],
      ['diff', `/workspaces/${ws}/docs/${encodeURIComponent(diffDoc)}`],
      ['folder', `/workspaces/${ws}/docs/${encodeURIComponent(folderDoc)}`],
    ];

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `page-load-${process.pid}`,
      (started) => {
        browsers.push(started);
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    // A returning reader: a first arrival gets the name prompt over the page.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
    });

    const read = async (): Promise<SlowestByPage> =>
      (await (await fetch(`${base}/api/load-reports/slowest`)).json()) as SlowestByPage;
    const loads: Record<string, number> = {};
    const arrived: Record<string, boolean> = {};
    for (const [page, path] of pages) {
      step(`open the ${page} page`);
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `${base}${path}` });
      await loaded;
      // Inside the client's own 15s deadline, so only a report sent at the
      // content counts as arrived; a deadline report would come later.
      const end = Date.now() + 12_000;
      let summary = (await read()).pages[page as keyof SlowestByPage['pages']];
      while ((summary?.loads ?? 0) === 0 && Date.now() < end) {
        await sleep(200);
        summary = (await read()).pages[page as keyof SlowestByPage['pages']];
      }
      loads[page] = summary?.loads ?? 0;
      arrived[page] = summary?.slowestMs !== null && summary?.slowestMs !== undefined;
    }
    cdp.close();
    const run: PageLoadRun = { loads, arrived };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
