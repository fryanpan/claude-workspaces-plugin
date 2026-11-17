#!/usr/bin/env bun
/**
 * The lead chat opened on a doc page, in headless Chromium against a real
 * server and the real doc bundle, at 1180x820 and at 430x932. It reads where
 * the open panel sits beside the doc's text column, then closes the panel and
 * reads the column again. Bryan's report: the open chat lay on top of the
 * document text instead of beside it.
 *
 * Spawned by `doc-lead-chat-dock-browser.test.ts`, which reads the JSON it
 * prints. `DOC_DOCK_SHOTS=<dir>` also writes a screenshot of each state.
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
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import type { DocDockRun, DocDockWidth, DockRead } from './doc-lead-chat-dock-browser-reading.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };

const step = (what: string): void => {
  process.stderr.write(`[doc-lead-chat-dock-driver] ${what}\n`);
};

async function until<T>(what: string, read: () => Promise<T | null>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

/** The agent button, the panel and its close control, the doc's text column
 *  and the doc's top bar, as boxes. The text column is the editor's own
 *  block: what the reader reads. `hidden` counts the column's text lines a
 *  point test finds covered by the panel, sampled down the column's right
 *  edge, where an overlapping panel lands first. */
const READ = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const layer = document.querySelector('[data-lead-chat="layer"]');
  const sr = layer && layer.shadowRoot;
  const pane = sr && sr.querySelector('.lc-pane');
  const close = sr && sr.querySelector('.lc-close');
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
  const shown = (el) => !!el && !el.hidden && el.getBoundingClientRect().width > 0;
  const col = document.querySelector('#editor > .ProseMirror');
  const paneShown = shown(pane) && pane.getAnimations().length === 0;
  let covered = 0;
  if (col && paneShown) {
    const c = col.getBoundingClientRect();
    for (const p of col.querySelectorAll('p')) {
      const r = p.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.width === 0) continue;
      const x = Math.min(r.right, c.right) - 4;
      const y = r.top + Math.min(r.height / 2, 8);
      const hit = document.elementFromPoint(x, y);
      if (hit === layer) covered++;
    }
  }
  // The paragraph at the top of the reader's view: the first whose bottom is
  // below the top bar.
  const bar = document.getElementById('topbar');
  const fold = bar ? bar.getBoundingClientRect().bottom : 0;
  const paras = col ? [...col.querySelectorAll('p')] : [];
  const topPara = paras.findIndex((p) => p.getBoundingClientRect().bottom > fold + 1);
  return {
    topPara,
    cards: document.body.dataset.cards || null,
    button: shown(btn) ? box(btn) : null,
    pane: paneShown ? box(pane) : null,
    close: shown(close) ? box(close) : null,
    column: col ? box(col) : null,
    topbar: box(document.getElementById('topbar')),
    covered,
    viewport: document.documentElement.clientWidth,
  };
})()`;

/** Scroll the doc's own scroller so its seventh paragraph is at the top. */
const SCROLL = `(() => {
  const col = document.querySelector('#editor > .ProseMirror');
  const p = col && col.querySelectorAll('p')[6];
  if (!p) return false;
  let el = col;
  while (el && !(el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  if (!el) return false;
  const bar = document.getElementById('topbar');
  el.scrollTop += p.getBoundingClientRect().top - (bar ? bar.getBoundingClientRect().bottom : 0) - 4;
  return true;
})()`;

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function tap(cdp: Cdp, r: { left: number; top: number; width: number; height: number }) {
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'doc-lead-chat-dock-'));
  const shots = process.env.DOC_DOCK_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
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
    const line =
      'The Riverbend crossing runs every forty minutes from the Harborlight pier, and the Saltmarsh shuttle meets each boat at the far landing so nobody waits in the rain.';
    const plan = join(dir, 'ferry.md');
    writeFileSync(plan, `# Harborlight ferry\n\n${Array(14).fill(line).join('\n\n')}\n`);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const server = handle;
    const base = `http://127.0.0.1:${server.port}`;
    const post = async (path: string, payload: unknown) => {
      const res = await fetch(`${base}${path}`, {
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
    server.tasks.attachAgent(ws, { ...LEAD, runtime: 'claude-code-local' });
    server.tasks.setLeadAgent(ws, LEAD.agentId, {
      actor: { id: 'known-alice', name: 'Alice', kind: 'known' },
    });
    const docId = String(
      (await post(`/workspaces/${ws}/docs`, { docId: 'ferry', type: 'markdown', sourceUrl: plan }))
        .docId,
    );
    const url = `${base}/workspaces/${ws}/docs/${docId}`;

    const widths: DocDockWidth[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      const b = await launchChrome(
        resolveChromeBin(undefined),
        (profile) => chromeLaunchArgs({ width, height }, profile),
        STARTUP_TIMEOUT_MS,
        `doc-lead-chat-dock-${width}-${process.pid}`,
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
        source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
      });
      const shot = async (name: string): Promise<void> => {
        if (!shots) return;
        const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
          data: string;
        };
        writeFileSync(
          join(shots, `doc-dock-${name}-${width}.png`),
          Buffer.from(png.data, 'base64'),
        );
      };
      const read = async (): Promise<DockRead> => (await cdp.evaluate(READ)) as DockRead;
      step(`open the doc at ${width}x${height}`);
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded;
      await until('the button and the doc text', async () => {
        const r = await read();
        return r.button && r.column && r.column.height > 0 ? r : null;
      });
      // The page may still be laying itself out and put the scroll back, so
      // scroll again until the doc holds still part-way down.
      const before = await until('the scroll settled into the doc', async () => {
        if ((await read()).topPara < 3 && !(await cdp.evaluate(SCROLL))) return null;
        await sleep(300);
        const a = await read();
        await sleep(300);
        const z = await read();
        const still = a.topPara === z.topPara && a.column?.width === z.column?.width;
        return still && z.topPara >= 3 ? z : null;
      });
      await shot('closed');
      await tap(cdp, before.button as NonNullable<DockRead['button']>);
      const open = await until('the panel open', async () => {
        const r = await read();
        return r.pane ? r : null;
      });
      // Let the column settle where the open panel put it, then read again.
      const settled = await until('the column settled', async () => {
        const a = await read();
        await sleep(150);
        const z = await read();
        return a.pane && z.pane && a.column?.width === z.column?.width ? z : null;
      });
      await shot('open');
      await tap(cdp, open.close as NonNullable<DockRead['close']>);
      const after = await until('the panel closed', async () => {
        const r = await read();
        return r.pane === null ? r : null;
      });
      const restored = await until('the column back', async () => {
        const a = await read();
        await sleep(150);
        const z = await read();
        return a.column?.width === z.column?.width ? z : null;
      }).catch(() => after);
      await shot('reclosed');
      widths.push({ width, before, open: settled, after: restored });
      cdp.close();
    }
    const run: DocDockRun = { widths };
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
