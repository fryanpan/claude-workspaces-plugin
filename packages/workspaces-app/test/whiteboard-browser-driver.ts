#!/usr/bin/env bun
/**
 * Two people on one whiteboard, in headless Chromium against a real server
 * and the real whiteboard bundle: one tab at 1180x820 (an iPad in
 * landscape), one at 430x932 (a phone). Each draws a pen stroke with touch
 * events, and the other tab has to show it. Neither page may scroll or zoom
 * under the pen.
 *
 * Spawned by `whiteboard-browser.test.ts`, which reads the JSON it prints.
 * `WHITEBOARD_SHOTS=<dir>` also writes a screenshot of each tab.
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
import type { WhiteboardRun, WhiteboardTab } from './whiteboard-browser-reading.ts';

const step = (what: string): void => {
  process.stderr.write(`[whiteboard-driver] ${what}\n`);
};

async function until<T>(
  what: string,
  read: () => Promise<T | null> | T | null,
  ms = 40_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(25);
  }
  throw new Error(`never happened: ${what}`);
}

let browser: { proc: ChildProcess; profile: string } | undefined;

const VIEW = `JSON.stringify({ scrollY: window.scrollY, scrollX: window.scrollX, scale: window.visualViewport ? window.visualViewport.scale : 1, elements: Number(document.body.dataset.elements || '0'), presence: document.getElementById('wb-presence')?.textContent ?? '', visibility: document.visibilityState })`;

interface View {
  scrollY: number;
  scrollX: number;
  scale: number;
  elements: number;
  presence: string;
  visibility: string;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'whiteboard-browser-'));
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
      url: string;
    };
    const url = `${base}${created.url}`;

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `whiteboard-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const first = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    const opened = (await (
      await fetch(`http://127.0.0.1:${b.port}/json/new?about:blank`, { method: 'PUT' })
    ).json()) as { webSocketDebuggerUrl: string };
    const second = await Cdp.connect(opened.webSocketDebuggerUrl);

    const tabs: Array<{ cdp: Cdp; name: string; width: number; height: number }> = [
      { cdp: first, name: 'Riverbend', width: 1180, height: 820 },
      { cdp: second, name: 'Saltmarsh', width: 430, height: 932 },
    ];
    for (const t of tabs) {
      await t.cdp.send('Page.enable');
      await t.cdp.send('Runtime.enable');
      await t.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: t.width,
        height: t.height,
        deviceScaleFactor: 1,
        mobile: t.width <= 1100,
      });
      await t.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await t.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try { localStorage.setItem('feedback-user-name', ${JSON.stringify(t.name)}); } catch {}`,
      });
      step(`open the whiteboard at ${t.width}x${t.height}`);
      const loaded = t.cdp.once('Page.loadEventFired');
      await t.cdp.send('Page.navigate', { url });
      await loaded;
      await until(`the canvas at ${t.width}`, async () =>
        (await t.cdp.evaluate(`document.body.dataset.whiteboardReady === '1'`)) ? true : null,
      );
    }
    const view = async (cdp: Cdp): Promise<View> =>
      JSON.parse(String(await cdp.evaluate(VIEW))) as View;
    // Both people present on both tabs before anyone draws.
    for (const t of tabs) {
      const other = tabs.find((o) => o !== t)?.name ?? '';
      await until(`presence of ${other} on ${t.name}'s tab`, async () =>
        (await view(t.cdp)).presence.includes(other) ? true : null,
      );
    }

    /** A pen stroke with touch: down, a dozen moves, up. */
    const drawStroke = async (cdp: Cdp, width: number, height: number) => {
      // Input sent to a tab that is not in front is never acknowledged.
      await cdp.send('Page.bringToFront');
      await cdp.evaluate(
        `document.querySelector('[data-testid="toolbar-freedraw"]')?.click(), true`,
      );
      const x0 = Math.round(width * 0.35);
      const y0 = Math.round(height * 0.45);
      const touch = (x: number, y: number) => [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
      const send = (params: Record<string, unknown>) =>
        Promise.race([
          cdp.send('Input.dispatchTouchEvent', params),
          sleep(10_000).then(() => {
            throw new Error(`touch ${String(params.type)} was never acknowledged`);
          }),
        ]);
      await send({ type: 'touchStart', touchPoints: touch(x0, y0) });
      for (let i = 1; i <= 12; i++) {
        await send({
          type: 'touchMove',
          touchPoints: touch(x0 + i * 8, y0 + Math.round(Math.sin(i / 2) * 20)),
        });
        await sleep(16);
      }
      await send({ type: 'touchEnd', touchPoints: [] });
    };

    const results: WhiteboardTab[] = [];
    for (const [i, from] of tabs.entries()) {
      const to = tabs[1 - i];
      if (!to) throw new Error('two tabs expected');
      const before = await view(from.cdp);
      const beforeOther = await view(to.cdp);
      step(`draw on the ${from.width} tab`);
      await drawStroke(from.cdp, from.width, from.height);
      const startedAt = Date.now();
      await until(`the stroke on the ${from.width} tab`, async () =>
        (await view(from.cdp)).elements > before.elements ? true : null,
      );
      await until(`the stroke reaching the ${to.width} tab`, async () =>
        (await view(to.cdp)).elements > beforeOther.elements ? true : null,
      ).catch(async (e) => {
        throw new Error(
          `${(e as Error).message}; that tab reads ${JSON.stringify(await view(to.cdp))}`,
        );
      });
      const reachedMs = Date.now() - startedAt;
      const after = await view(from.cdp);
      results.push({
        width: from.width,
        height: from.height,
        drewElements: after.elements - before.elements,
        otherTabSaw: (await view(to.cdp)).elements - beforeOther.elements,
        reachedMs,
        scrollBefore: [before.scrollX, before.scrollY],
        scrollAfter: [after.scrollX, after.scrollY],
        scaleBefore: before.scale,
        scaleAfter: after.scale,
      });
      if (shots) {
        const png = (await from.cdp.send('Page.captureScreenshot', { format: 'png' })) as {
          data: string;
        };
        writeFileSync(join(shots, `whiteboard-${from.width}.png`), Buffer.from(png.data, 'base64'));
      }
    }
    const scene = (await (
      await fetch(`${base}/workspaces/${ws}/docs/${created.url.split('/').pop()}/whiteboard`)
    ).json()) as { shapes: Array<{ kind: string }> };
    const run: WhiteboardRun = {
      tabs: results,
      storedKinds: scene.shapes.map((s) => s.kind),
    };
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
