#!/usr/bin/env bun
/**
 * Where the comment pill lands on a code file's diff, in headless Chromium
 * against a real server and the real doc bundle.
 *
 * A two-commit repo changes a few lines of `app.js`; its diff review is
 * opened at 1180x820 and at 430x932, and on each the reader drags across part
 * of one line, drags from the middle of one line to the start of a later one,
 * and clicks once inside a line. After each, the driver reads the pill's box
 * and the box of the text the pill belongs beside: the last selected
 * character, or the clicked line's last character. At 430 it also taps a
 * line with a finger, and selects a word natively the way a long-press does.
 *
 * Spawned by `code-diff-pill-browser.test.ts`, which reads the JSON it
 * prints. `CODE_PILL_SHOTS=<dir>` writes a screenshot per step.
 * `CODE_PILL_APP=<dir>` builds the doc bundle from another checkout's
 * `packages/workspaces-app`, which is how the positive control runs.
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
import type { PillReading, PillRun, PillWidth } from './code-diff-pill-browser-reading.ts';

const BASE_JS = [
  "const port = 'riverbend';",
  'function dock(boat) {',
  '  return boat.berth;',
  '}',
  'const tide = 1;',
  'const ferry = 2;',
  'const slip = 3;',
  'export { dock };',
  '',
].join('\n');
const TARGET_JS = [
  "const port = 'harborlight';",
  'function dock(boat) {',
  '  const berth = boat.berth ?? 0;',
  '  return berth + 1;',
  '}',
  'const tide = 10;',
  'const ferry = 20;',
  'const slip = 3;',
  'export { dock };',
  '',
].join('\n');

const step = (what: string): void => {
  process.stderr.write(`[code-pill-driver] ${what}\n`);
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

/**
 * Page-side helpers. `__at(needle, col)` is the viewport point of character
 * `col` of the first target-side line whose text starts with `needle` (the
 * deleted-line widgets are skipped: they are not in the CM document).
 * `__read(needle, lastCol)` reads the pill and that character's box.
 * `__selectNative(needle, from, to)` selects columns [from, to) natively.
 */
const HELPERS = `(() => {
  const lineOf = (needle) => [...document.querySelectorAll('#editor .cm-content > .cm-line')]
    .find((l) => l.textContent.startsWith(needle));
  const nodeAt = (needle, col) => {
    const line = lineOf(needle);
    if (!line) throw new Error('no line ' + needle);
    const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let left = col;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (left < n.length) return [n, left];
      left -= n.length;
    }
    throw new Error('no column ' + col + ' in ' + needle);
  };
  const charBox = (needle, col) => {
    const [n, at] = nodeAt(needle, col);
    const r = document.createRange();
    r.setStart(n, at);
    r.setEnd(n, at + 1);
    return r.getBoundingClientRect();
  };
  // What a long-press and its handles leave behind: a native selection the
  // page did not make through mouse events.
  window.__selectNative = (needle, from, to) => {
    const [a, aAt] = nodeAt(needle, from);
    const [b, bAt] = nodeAt(needle, to - 1);
    getSelection().setBaseAndExtent(a, aAt, b, bAt + 1);
    return true;
  };
  window.__at = (needle, col, side) => {
    const b = charBox(needle, col);
    const x = side === 'left' ? b.left + 1 : side === 'right' ? b.right - 1 : b.left + b.width / 2;
    return { x, y: b.top + b.height / 2 };
  };
  window.__lineStart = (needle) => {
    const b = charBox(needle, 0);
    return { x: b.left - 2, y: b.top + b.height / 2 };
  };
  window.__read = (needle, lastCol) => {
    const pill = document.getElementById('comment-pill');
    const shown = !!pill && !pill.classList.contains('hidden') && pill.getClientRects().length > 0;
    const p = shown ? pill.getBoundingClientRect() : null;
    const t = charBox(needle, lastCol);
    return {
      pill: p ? { left: Math.round(p.left), right: Math.round(p.right), top: Math.round(p.top), bottom: Math.round(p.bottom) } : null,
      text: { right: Math.round(t.right), top: Math.round(t.top), bottom: Math.round(t.bottom) },
    };
  };
  return true;
})()`;

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

type Pt = { x: number; y: number };

async function openPage(url: string, width: number, height: number) {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile),
    STARTUP_TIMEOUT_MS,
    `code-pill-${width}-${process.pid}`,
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
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Bob'); } catch {}`,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  await until('the diff rendered', async () =>
    (await cdp.evaluate(
      `[...document.querySelectorAll('#editor .cm-content > .cm-line')].some((l) => l.textContent.startsWith('const tide = 10'))`,
    ))
      ? true
      : null,
  );
  await cdp.evaluate(HELPERS);
  const at = (needle: string, col: number, side?: 'left' | 'right') =>
    cdp.evaluate(
      `__at(${JSON.stringify(needle)}, ${col}, ${JSON.stringify(side ?? '')})`,
    ) as Promise<Pt>;
  const mouse = (type: string, p: Pt, extra: Record<string, unknown> = {}) =>
    cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', ...extra });
  const frames = () =>
    cdp.evaluate(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
    );
  /** Press empty space so the previous step's selection and pill are gone. */
  const reset = async () => {
    await cdp.evaluate(`document.getElementById('comment-pill')?.classList.add('hidden'); true`);
    await mouse('mousePressed', { x: width - 4, y: height - 4 }, { clickCount: 1 });
    await mouse('mouseReleased', { x: width - 4, y: height - 4 }, { clickCount: 1 });
    await cdp.evaluate('getSelection()?.removeAllRanges(); true');
    await frames();
  };
  const drag = async (from: Pt, to: Pt) => {
    await mouse('mouseMoved', from, { button: 'none' });
    await mouse('mousePressed', from, { clickCount: 1 });
    const n = 6;
    for (let i = 1; i <= n; i++) {
      await mouse(
        'mouseMoved',
        { x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n },
        { buttons: 1 },
      );
    }
    await mouse('mouseReleased', to, { clickCount: 1 });
  };
  const click = async (p: Pt) => {
    await mouse('mouseMoved', p, { button: 'none' });
    await mouse('mousePressed', p, { clickCount: 1 });
    await mouse('mouseReleased', p, { clickCount: 1 });
  };
  const tap = async (p: Pt) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  /** The pill is placed after a 30ms settle on a click; read past it. */
  const read = async (needle: string, lastCol: number): Promise<PillReading> => {
    let last: PillReading | null = null;
    await until(
      `a pill beside ${needle}`,
      async () => {
        await frames();
        last = (await cdp.evaluate(`__read(${JSON.stringify(needle)}, ${lastCol})`)) as PillReading;
        return last.pill ? last : null;
      },
      1_500,
    ).catch(() => null);
    return last as unknown as PillReading;
  };
  const shots = process.env.CODE_PILL_SHOTS;
  const shot = async (name: string) => {
    if (!shots) return;
    const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    writeFileSync(join(shots, `${name}-${width}.png`), Buffer.from(png.data, 'base64'));
  };
  return { cdp, at, drag, click, tap, reset, read, shot };
}

async function walk(url: string, width: number, height: number): Promise<PillWidth> {
  step(`${width}x${height}`);
  const page = await openPage(url, width, height);
  if (width <= 1100) {
    await page.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }

  // Part of one line: "tide" in "const tide = 10;" (columns 6-9).
  await page.reset();
  await page.drag(
    await page.at('const tide = 10', 6, 'left'),
    await page.at('const tide = 10', 9, 'right'),
  );
  const withinLine = await page.read('const tide = 10', 9);
  await page.shot('within-line');

  // Middle of one line to the very start of a later one: the selection's
  // last character is the end of the line in between.
  await page.reset();
  const lineStart = (await page.cdp.evaluate(
    `__lineStart(${JSON.stringify('const slip = 3')})`,
  )) as Pt;
  await page.drag(await page.at('const tide = 10', 6, 'left'), lineStart);
  const toLineStart = await page.read('const ferry = 20;', 'const ferry = 20;'.length - 1);
  await page.shot('to-line-start');

  // A single click inside a line: the pill goes at that line's end.
  await page.reset();
  await page.click(await page.at('const ferry = 20;', 3));
  const click = await page.read('const ferry = 20;', 'const ferry = 20;'.length - 1);
  await page.shot('click');

  let tap: PillReading | null = null;
  let longPress: PillReading | null = null;
  if (width <= 1100) {
    await page.reset();
    await page.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.tap(await page.at('const ferry = 20;', 3));
    tap = await page.read('const ferry = 20;', 'const ferry = 20;'.length - 1);
    await page.shot('tap');

    await page.reset();
    await page.cdp.evaluate(`__selectNative('const tide = 10', 6, 10)`);
    longPress = await page.read('const tide = 10', 9);
    await page.shot('long-press');
  }
  page.cdp.close();
  return { width, withinLine, toLineStart, click, tap, longPress };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'code-pill-'));
  const shots = process.env.CODE_PILL_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let handle: ServerHandle | undefined;
  try {
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    step('build the doc bundle');
    const appPkg = process.env.CODE_PILL_APP ?? join(import.meta.dirname, '..');
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
    writeFileSync(join(repo, 'app.js'), TARGET_JS);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'target');
    const target = git(repo, 'rev-parse', 'HEAD');

    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const server = handle;
    const origin = `http://127.0.0.1:${server.port}`;
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
    const review = (await post(`/workspaces/${ws}/attachments`, {
      repo,
      base,
      target,
      owner: repo,
    })) as { files?: Array<{ docId: string; relPath?: string }> };
    const docId = review.files?.[0]?.docId;
    if (!docId) throw new Error(`no diff member: ${JSON.stringify(review)}`);
    const url = `${origin}/workspaces/${ws}/docs/${encodeURIComponent(docId)}`;

    const run: PillRun = {
      wide: await walk(url, 1180, 820),
      phone: await walk(url, 430, 932),
    };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 170s');
  void Promise.all(browsers.map((b) => stopBrowser(b.proc, b.profile))).finally(() =>
    process.exit(3),
  );
}, 170_000).unref();
await main();
process.exit(0);
