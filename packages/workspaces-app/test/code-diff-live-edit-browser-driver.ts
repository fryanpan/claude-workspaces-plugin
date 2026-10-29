#!/usr/bin/env bun
/**
 * Whether a code file's diff view stays in Diff when the file changes on disk
 * under a LIVE working-tree review, in headless Chromium against a real
 * server and the real doc bundle.
 *
 * A one-commit repo has `app.js` modified in the working tree; a live diff
 * review (no target) is opened at 1180x820, the page is read in Diff mode,
 * then the driver rewrites `app.js` on disk the way an agent's save does,
 * waits for the new line to reach the page, and reads the view mode again.
 *
 * Spawned by `code-diff-live-edit-browser.test.ts`, which reads the JSON it
 * prints. `CODE_LIVE_APP=<dir>` builds the doc bundle from another
 * checkout's `packages/workspaces-app`, which is how the positive control
 * runs.
 */
import { type ChildProcess, execFileSync, spawnSync } from 'node:child_process';
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
import type { LiveEditRun, ModeReading } from './code-diff-live-edit-browser-reading.ts';

const BASE_JS = [
  "const port = 'riverbend';",
  'function dock(boat) {',
  '  return boat.berth;',
  '}',
  ...Array.from({ length: 120 }, (_, i) => `const buoy${i} = ${i};`),
  'export { dock };',
  '',
].join('\n');
/** The working tree when the review opens: two changes far apart. */
const FIRST_EDIT = BASE_JS.replace('const buoy30 = 30;', 'const buoy30 = 300;').replace(
  'const buoy90 = 90;',
  'const buoy90 = 900;',
);
/** The agent's save while the reviewer reads: one line, above the viewport. */
const SECOND_EDIT = FIRST_EDIT.replace("const port = 'riverbend';", "const port = 'harborlight';");

const step = (what: string): void => {
  process.stderr.write(`[code-live-driver] ${what}\n`);
};

async function until<T>(
  what: string,
  read: () => Promise<T | null> | T | null,
  ms = 30_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Alice',
      GIT_AUTHOR_EMAIL: 'alice@example.invalid',
      GIT_COMMITTER_NAME: 'Alice',
      GIT_COMMITTER_EMAIL: 'alice@example.invalid',
    },
  }).trim();
}

/** What the page shows: which mode the surface and the toggle are in, and
 *  whether the deleted base line of the latest edit is drawn. */
const READ = `(() => {
  const cm = document.querySelector('#editor .cm-editor');
  const btn = document.getElementById('view-diff');
  const lines = [...document.querySelectorAll('#editor .cm-content > .cm-line')].map((l) => l.textContent);
  const deleted = [...document.querySelectorAll('#editor .cm-deletedChunk')].map((d) => d.textContent).join('\\n');
  const scroller = document.querySelector('#editor .cm-scroller');
  const pill = document.getElementById('comment-pill');
  const top = scroller ? scroller.getBoundingClientRect().top : 0;
  const firstVisible = [...document.querySelectorAll('#editor .cm-content > .cm-line')]
    .find((l) => l.getBoundingClientRect().bottom > top + 1);
  return {
    pillShown: !!pill && !pill.classList.contains('hidden') && pill.getClientRects().length > 0,
    firstVisibleLine: firstVisible ? firstVisible.textContent : null,
    collapsedBars: document.querySelectorAll('#editor .cm-collapsedLines').length,
    fileMode: !!cm && cm.classList.contains('cm-file-mode'),
    diffButtonActive: !!btn && btn.classList.contains('active'),
    lines,
    deleted,
    scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
  };
})()`;

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'code-live-'));
  let handle: ServerHandle | undefined;
  try {
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    step('build the doc bundle');
    const appPkg = process.env.CODE_LIVE_APP ?? join(import.meta.dirname, '..');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(appPkg, 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000, cwd: appPkg },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);

    const repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'app.js'), BASE_JS);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'app.js'), FIRST_EDIT);

    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const origin = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, payload: unknown) => {
      const res = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const author = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author })) as { workspace: { id: string } }
    ).workspace.id;
    // No target: the review tracks the live working tree.
    const review = (await post(`/workspaces/${ws}/attachments`, {
      repo,
      base,
      owner: repo,
    })) as { files?: Array<{ docId: string }> };
    const docId = review.files?.[0]?.docId;
    if (!docId) throw new Error(`no diff member: ${JSON.stringify(review)}`);
    const url = `${origin}/workspaces/${ws}/docs/${encodeURIComponent(docId)}`;

    const width = 1180;
    const height = 820;
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width, height }, profile),
      STARTUP_TIMEOUT_MS,
      `code-live-${process.pid}`,
      (started) => {
        browsers.push(started);
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Bob'); } catch {}`,
    });
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url });
    await loaded;
    const read = async () => (await cdp.evaluate(READ)) as ModeReading;
    const has = (r: ModeReading, needle: string) => r.lines.some((l) => l.startsWith(needle));

    step('wait for the diff');
    await until('the diff rendered', async () => {
      const r = await read();
      return has(r, 'const buoy90 = 900') && r.deleted.includes('const buoy90 = 90;') ? r : null;
    });
    // Bring the second change to the top of the viewport, then click a line
    // in it so the comment pill shows: the reader is mid-review.
    await cdp.evaluate(`(() => {
      const line = [...document.querySelectorAll('#editor .cm-content > .cm-line')]
        .find((l) => l.textContent.startsWith('const buoy90 = 900'));
      line.scrollIntoView({ block: 'start' });
      return true;
    })()`);
    const at = (await cdp.evaluate(`(() => {
      const line = [...document.querySelectorAll('#editor .cm-content > .cm-line')]
        .find((l) => l.textContent.startsWith('const buoy91 = 91'));
      const b = line.getBoundingClientRect();
      return { x: b.left + 20, y: b.top + b.height / 2 };
    })()`)) as { x: number; y: number };
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 });
    }
    const before = await until('the pill showed', async () => {
      const r = await read();
      return r.pillShown ? r : null;
    });

    step('edit the file on disk');
    writeFileSync(join(repo, 'app.js'), SECOND_EDIT);
    const after = await until(
      'the edit reached the page, with its deleted base line',
      async () => {
        const r = await read();
        return r.fileMode || r.deleted.includes("const port = 'riverbend'") ? r : null;
      },
      30_000,
    );

    cdp.close();
    const run: LiveEditRun = { before, after };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    for (const br of browsers) await stopBrowser(br.proc, br.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 170s');
  void Promise.all(browsers.map((br) => stopBrowser(br.proc, br.profile))).finally(() =>
    process.exit(3),
  );
}, 170_000).unref();
await main();
process.exit(0);
