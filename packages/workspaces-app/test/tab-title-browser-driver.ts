#!/usr/bin/env bun
/**
 * Every page's browser tab title starts with the workspace's name, in
 * headless Chromium against a real server and the real bundles, at 1180x820
 * and 430x932 (Bryan, 4 Nov: "I want to make sure that every single page has a
 * title that starts with the workspace name").
 *
 * Boots a server with one board, Harborlight, holding a task, a goal, a doc,
 * a mock, a diff review and a bound folder, and opens each kind of page in
 * turn, reading `document.title` once the page has drawn.
 *
 * Then, with a page open, it renames the workspace and the thing the page
 * shows, and reads the title again without reloading — on a doc, on a mock
 * and on a task, so each kind of live path is driven.
 *
 * Spawned by `tab-title-browser.test.ts`, which reads the JSON this prints
 * last.
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
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';
import {
  EXPECTED,
  type LiveRename,
  PAGE_KINDS,
  type PageKind,
  type TabTitleRun,
  type TitleRead,
} from './tab-title-browser-reading.ts';

const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

const step = (what: string): void => {
  process.stderr.write(`[tab-title-driver] ${what}\n`);
};

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

/** The title once it satisfies `ok`, or whatever it reads at the deadline. */
async function titleWhen(cdp: Cdp, ok: (t: string) => boolean, ms = 8_000): Promise<string> {
  const end = Date.now() + ms;
  let t = '';
  while (Date.now() < end) {
    t = String(await cdp.evaluate('document.title'));
    if (ok(t)) return t;
    await sleep(50);
  }
  return t;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'tab-title-'));
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
    const server = handle;
    const base = `http://127.0.0.1:${server.port}`;
    const call = async (method: string, path: string, payload: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const post = (path: string, payload: unknown) => call('POST', path, payload);

    step('seed Harborlight with a task, a goal, a doc, a mock, a diff and a folder');
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author: ALICE })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const goals = server.tasks.setGoalList(ws, [{ title: 'Open the Riverbend ferry' }], {
      actor: ALICE,
    });
    if (!goals.ok) throw new Error('the goal was refused');
    const goalId = server.tasks.getWorkspace(ws)?.goals?.[0]?.id;
    const made = server.tasks.createTask(ws, {
      title: 'Paint the Saltmarsh slipway',
      body: 'Alice can paint the slipway so that the ferry docks.',
      actor: ALICE,
    });
    if (!made.ok || !goalId) throw new Error('the task or the goal was not made');
    const taskId = made.task.id;

    const docFile = join(dir, 'tides.md');
    writeFileSync(docFile, '# Riverbend tides\n\nThe Saltmarsh slipway floods at noon.\n');
    const docId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'tides',
          type: 'markdown',
          title: 'Riverbend tides',
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
          title: 'Moorings',
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

    const paths: Record<PageKind, string> = {
      board: `/workspaces/${ws}`,
      home: `/workspaces/${ws}/home`,
      task: `/workspaces/${ws}?task=${encodeURIComponent(taskId)}`,
      goal: `/workspaces/${ws}?goal=${encodeURIComponent(goalId)}`,
      doc: `/workspaces/${ws}/docs/${encodeURIComponent(docId)}`,
      mock: `/workspaces/${ws}/mockups/${encodeURIComponent(mockId)}`,
      diff: `/workspaces/${ws}/docs/${encodeURIComponent(diffDoc)}`,
      folder: `/workspaces/${ws}/docs/${encodeURIComponent(folderDoc)}`,
    };

    const reads: TitleRead[] = [];
    const live: LiveRename[] = [];
    // 430 first: the renames run at 1180, after every page has been read
    // under its first names at both widths.
    for (const [width, height] of [
      [430, 932],
      [1180, 820],
    ] as const) {
      const b = await launchChrome(
        resolveChromeBin(undefined),
        (profile) => chromeLaunchArgs({ width, height }, profile),
        STARTUP_TIMEOUT_MS,
        `tab-title-${width}-${process.pid}`,
        (started) => {
          browsers.push(started);
        },
      );
      const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width <= 1100,
      });
      // A returning reader: a first arrival gets the name prompt over the page.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
      });
      const open = async (path: string): Promise<void> => {
        const loaded = cdp.once('Page.loadEventFired');
        await cdp.send('Page.navigate', { url: `${base}${path}` });
        await loaded;
      };
      for (const page of PAGE_KINDS) {
        step(`open the ${page} page at ${width}`);
        await open(paths[page]);
        // A page names itself in steps (the shell, then the client), so wait
        // for the title it should end on; a miss reads whatever it got to.
        const title = await titleWhen(cdp, (t) => t === EXPECTED[page]);
        reads.push({ width, page, title });
        step(`  ${JSON.stringify(title)}`);
      }

      if (width === 1180) {
        const renames: Array<{
          page: LiveRename['page'];
          workspace: string;
          name: string;
          rename: (name: string) => Promise<unknown>;
        }> = [
          {
            page: 'doc',
            workspace: 'Riverbend',
            name: 'Saltmarsh tides',
            rename: (title) =>
              call('PUT', `/workspaces/${ws}/docs/${encodeURIComponent(docId)}/title`, { title }),
          },
          {
            page: 'mock',
            workspace: 'Saltmarsh',
            name: 'Riverbend moorings',
            rename: (title) =>
              call('PUT', `/workspaces/${ws}/docs/${encodeURIComponent(mockId)}/title`, { title }),
          },
          {
            page: 'task',
            workspace: 'Harborlight',
            name: 'Paint the Riverbend slipway',
            rename: (title) =>
              post(`/workspaces/${ws}/tasks/${encodeURIComponent(taskId)}/title`, {
                title,
                author: ALICE,
              }),
          },
        ];
        let current = 'Harborlight';
        for (const r of renames) {
          step(`rename under an open ${r.page} page`);
          await open(paths[r.page]);
          const before = await titleWhen(
            cdp,
            (t) => t.startsWith(current) && t.split(' · ').length > 2,
          );
          await cdp.evaluate('window.__cwSameDocument = true');
          await post(`/workspaces/${ws}/rename`, { name: r.workspace, author: ALICE });
          const afterWorkspace = await titleWhen(cdp, (t) => t.startsWith(`${r.workspace} · `));
          current = r.workspace;
          await r.rename(r.name);
          const afterName = await titleWhen(
            cdp,
            (t) => t === `${r.workspace} · ${r.name} · Workspaces`,
          );
          const sameDocument = (await cdp.evaluate('window.__cwSameDocument === true')) === true;
          live.push({ ...r, before, afterWorkspace, afterName, sameDocument });
          step(`  ${JSON.stringify(live.at(-1))}`);
        }
      }
      cdp.close();
    }
    const run: TabTitleRun = { workspace: 'Harborlight', reads, live };
    // Drain before exit: a line cut off at the pipe's buffer is no JSON.
    await new Promise<void>((r) => process.stdout.write(`\n${JSON.stringify(run)}\n`, () => r()));
  } finally {
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 230s');
  void Promise.all(browsers.map((b) => stopBrowser(b.proc, b.profile))).finally(() =>
    process.exit(3),
  );
}, 230_000).unref();
await main();
process.exit(0);
