#!/usr/bin/env bun
/**
 * An agent's `replace` landing in the middle of a person's drag, in headless
 * Chromium against a real server and the real whiteboard bundle. The person
 * selects the whole board and holds it mid-drag while the agent replaces it,
 * then lets go. The JSON this prints says what the board and the tab hold
 * afterwards.
 *
 * Spawned by `whiteboard-replace-browser.test.ts`. `WHITEBOARD_SHOTS=<dir>`
 * also writes a screenshot of the tab at the end.
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
import { allSceneElements } from '../../core/src/whiteboard-scene.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';

/** What the driver reports. */
export interface ReplaceRun {
  /** Live elements before the replace: what the tab was holding mid-drag. */
  before: number;
  /** The ids the board holds once the person has let go. */
  ids: string[];
  /** The kept box as the board holds it. */
  kept: { x: number; y: number; text?: string } | null;
  /** The heading's width once a real canvas has held it. */
  headingWidth: number | null;
  /** The heading's widest line in the canvas font, in pixels. */
  headingInk: number;
  /** Dark pixels the tab paints in the middle of the kept box: its words. */
  tabLabelInk: number;
  /** The kept box's words as the board holds them, against the box. */
  labelInBox: boolean;
  /** Live elements on the board. */
  count: number;
  /** Live elements the tab shows. */
  tabElements: number;
}

const step = (what: string): void => {
  process.stderr.write(`[whiteboard-replace-driver] ${what}\n`);
};

async function until<T>(what: string, read: () => Promise<T | null> | T | null): Promise<T> {
  const end = Date.now() + 40_000;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(25);
  }
  throw new Error(`never happened: ${what}`);
}

const HEADING = 'HARBORLIGHT FERRY CROSSINGS: WINTER SEASON TIMETABLE';

/** The page script that measures the widest of some lines in the canvas font. */
const inkOf = (lines: string[]): string =>
  `(() => {
    const c = document.createElement('canvas').getContext('2d');
    c.font = '20px Excalifont';
    return Math.max(...${JSON.stringify(lines)}.map((l) => c.measureText(l).width));
  })()`;

/** The page script that counts dark pixels the static canvas has around a point. */
const darkPixels = (at: { x: number; y: number }): string =>
  `(() => {
    const canvas = document.querySelector('canvas.static');
    const box = canvas.getBoundingClientRect();
    const { data } = canvas
      .getContext('2d')
      .getImageData(${at.x} - box.left - 60, ${at.y} - box.top - 16, 120, 32);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 128 && data[i] < 128) dark++;
    return dark;
  })()`;

let browser: { proc: ChildProcess; profile: string } | undefined;

interface Scene {
  shapes: Array<{ id: string; x: number; y: number; w?: number; text?: string }>;
  count: number;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'whiteboard-replace-'));
  const shots = process.env.WHITEBOARD_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let handle: ServerHandle | undefined;
  try {
    step('build the app bundle');
    const appPkg = join(import.meta.dirname, '..');
    const built = spawnSync('bun', ['run', join(appPkg, 'scripts', 'build.ts')], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    if (built.status !== 0) throw new Error(`app bundle build failed:\n${built.stderr}`);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      markdownAppDistDir: join(appPkg, 'dist'),
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
    const author = { id: 'agent-harborlight', name: 'Harborlight', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const created = (await post(`/workspaces/${ws}/whiteboards`, { title: 'Ferry flow' })) as {
      docId: string;
      url: string;
    };
    const scenePath = `/workspaces/${ws}/docs/${created.docId}/whiteboard`;
    const scene = async () => (await (await fetch(`${base}${scenePath}`)).json()) as Scene;
    await post(scenePath, {
      author,
      shapes: [
        { id: 'kept', kind: 'box', x: 0, y: 0, w: 200, h: 120, text: 'Riverbend' },
        { id: 'gone', kind: 'box', x: 260, y: 0, w: 200, h: 120, text: 'Saltmarsh' },
        { id: 'link', kind: 'arrow', x: 0, y: 0, from: 'kept', to: 'gone' },
      ],
    });
    const before = (await scene()).count;

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `whiteboard-replace-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1180,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Riverbend'); } catch {}`,
    });
    step('open the whiteboard');
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${base}${created.url}` });
    await loaded;
    await until('the canvas', async () =>
      (await cdp.evaluate("document.body.dataset.whiteboardReady === '1'")) ? true : null,
    );
    await cdp.send('Page.bringToFront');
    const tabElements = async () =>
      Number(await cdp.evaluate('Number(document.body.dataset.elements ?? 0)'));

    const mouse = (type: string, x: number, y: number, buttons: number) =>
      cdp.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        buttons,
        button: type === 'mouseMoved' ? 'none' : 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1,
      });
    const stageBox = JSON.parse(
      String(
        await cdp.evaluate(
          `JSON.stringify(document.querySelector('.wb-canvas').getBoundingClientRect())`,
        ),
      ),
    ) as { left: number; top: number; width: number; height: number };
    const mid = {
      x: Math.round(stageBox.left + stageBox.width / 2),
      y: Math.round(stageBox.top + stageBox.height / 2),
    };

    step('select everything by sweeping a box over it');
    await mouse('mouseMoved', stageBox.left + 80, stageBox.top + 90, 0);
    await mouse('mousePressed', stageBox.left + 80, stageBox.top + 90, 1);
    await mouse('mouseMoved', mid.x, mid.y, 1);
    await mouse(
      'mouseMoved',
      stageBox.left + stageBox.width - 80,
      stageBox.top + stageBox.height - 90,
      1,
    );
    await mouse(
      'mouseReleased',
      stageBox.left + stageBox.width - 80,
      stageBox.top + stageBox.height - 90,
      0,
    );
    await until('the selection', async () =>
      (await cdp.evaluate(`!!document.querySelector('.selected-shape-actions')`)) ? true : null,
    );

    step('hold a drag');
    await mouse('mouseMoved', mid.x, mid.y, 0);
    await mouse('mousePressed', mid.x, mid.y, 1);
    for (let i = 1; i <= 30; i++) {
      await mouse('mouseMoved', mid.x + i * 4, mid.y + i, 1);
      await sleep(16);
    }

    step('the agent replaces the board');
    await post(scenePath, {
      author,
      mode: 'replace',
      shapes: [
        { id: 'kept', kind: 'box', x: 40, y: 300, w: 200, h: 120, text: 'Harborlight' },
        { id: 'fresh', kind: 'box', x: 300, y: 300, w: 200, h: 120, text: 'Riverbend' },
        { id: 'heading', kind: 'text', x: 40, y: 200, w: 640, text: HEADING },
      ],
    });
    // The socket frame reaching the tab, while the pen is still down.
    await sleep(500);

    step('let go');
    await mouse('mouseMoved', mid.x + 124, mid.y + 31, 1);
    await mouse('mouseReleased', mid.x + 124, mid.y + 31, 0);
    // The page writes on the change a pointer-up reports, and a second
    // change from a plain move reports anything left over.
    await sleep(500);
    await mouse('mouseMoved', mid.x + 150, mid.y + 60, 0);
    await sleep(500);

    const end = await scene();
    const live = handle.docStore.get(created.docId);
    if (!live) throw new Error('the whiteboard is not in memory');
    const stored = allSceneElements(live.ydoc);
    const label = stored.find((e) => e.id === 'kept-label');
    const box = stored.find((e) => e.id === 'kept');
    const headingLines = String(stored.find((e) => e.id === 'heading')?.text).split('\n');
    // The canvas opened centred on the first drawing, 460 by 120 at the
    // origin, and nothing has scrolled it, so this is the kept box's centre.
    const inkAt = { x: mid.x + 140 - 230, y: mid.y + 360 - 60 };
    const run: ReplaceRun = {
      before,
      ids: end.shapes.map((s) => s.id).sort(),
      kept: end.shapes.find((s) => s.id === 'kept') ?? null,
      tabLabelInk: Number(await cdp.evaluate(darkPixels(inkAt))),
      labelInBox:
        !!label &&
        !!box &&
        Number(label.x) >= Number(box.x) &&
        Number(label.x) + Number(label.width) <= Number(box.x) + Number(box.width) &&
        Number(label.y) >= Number(box.y) &&
        Number(label.y) + Number(label.height) <= Number(box.y) + Number(box.height),
      headingWidth: end.shapes.find((s) => s.id === 'heading')?.w ?? null,
      headingInk: Number(await cdp.evaluate(inkOf(headingLines))),
      count: end.count,
      tabElements: await tabElements(),
    };
    if (shots) {
      const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
      writeFileSync(join(shots, 'whiteboard-replace.png'), Buffer.from(png.data, 'base64'));
    }
    console.log(JSON.stringify(run));
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
