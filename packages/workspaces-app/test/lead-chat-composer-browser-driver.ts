#!/usr/bin/env bun
/**
 * The composer in headless Chromium against a real server and the real
 * bundles, at 1180x820 and 430x932: dragging files over it, dropping them,
 * pasting nothing else, and sending, with a second tab already open on the
 * board. Spawned by `lead-chat-composer-browser.test.ts`, which reads the
 * JSON it prints. `CW_COMPOSER_SHOTS=<dir>` also writes a screenshot of each
 * state, for a person to look at.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };
const SHOTS = process.env.CW_COMPOSER_SHOTS;

export interface ComposerCase {
  width: number;
  /** The box and the row above it, before and during a drag. */
  rest: Box;
  dragged: Box;
  outline: string;
  chips: number;
  sendEnabledWithNoWords: boolean;
  /** The row's controls, left to right. */
  row: string[];
  /** Widest the panel lets the row run: nothing may overflow it. */
  rowOverflows: boolean;
  sent: { thumbs: number; loaded: boolean; files: number };
  /** The same message, in a tab that was already open. */
  otherTab: { thumbs: number; files: number };
  /** The chip's box before and after the model changed. */
  chipOpenedNothing: boolean;
  chipBefore: Box;
  chipAfter: Box;
  chipText: string;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ComposerRun {
  cases: ComposerCase[];
}

async function until<T>(
  what: string,
  read: () => Promise<T | null> | T | null,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined && (v as unknown) !== false) return v;
    await sleep(25);
  }
  throw new Error(`never happened: ${what}`);
}

const SR = `document.querySelector('[data-lead-chat="layer"]')?.shadowRoot`;
const box = (q: string) => `(() => {
  const r = ${SR}?.querySelector(${JSON.stringify(q)})?.getBoundingClientRect();
  return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
})()`;

/** Real DragEvents holding real Files, as Chromium builds them for a drop. */
const FIRE = (type: string): string => `(() => {
  const target = ${SR}.querySelector('.lc-compose');
  const dt = new DataTransfer();
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  dt.items.add(new File([png], 'berth.png', { type: 'image/png' }));
  dt.items.add(new File(['tide,height'], 'tide.csv', { type: 'text/csv' }));
  target.dispatchEvent(new DragEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
  return true;
})()`;

const READ_ROW = `[...${SR}.querySelector('.lc-actions').children].filter((n) => n.getBoundingClientRect().width > 0 && !n.classList.contains('lc-grow')).map((n) => n.getAttribute('aria-label') || n.textContent)`;
const OVERFLOW = `(() => { const r = ${SR}.querySelector('.lc-actions'); return r.scrollWidth > r.clientWidth; })()`;

const SENT = `(() => {
  const m = [...${SR}.querySelectorAll('.lc-list .lc-msg')].at(-1);
  const imgs = m ? [...m.querySelectorAll('.lc-thumbs img')] : [];
  return { thumbs: imgs.length, loaded: imgs.every((i) => i.complete && i.naturalWidth > 0), files: m ? m.querySelectorAll('.lc-sent-file').length : 0 };
})()`;

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function openBrowser(width: number, height: number): Promise<{ cdp: Cdp; port: number }> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile, ['--mute-audio']),
    STARTUP_TIMEOUT_MS,
    `lead-chat-composer-${width}-${process.pid}`,
    (started) => {
      browsers.push(started);
    },
  );
  const cdp = await pageAt(b.port, await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS), width, height);
  return { cdp, port: b.port };
}

async function pageAt(_port: number, ws: string, width: number, height: number): Promise<Cdp> {
  const cdp = await Cdp.connect(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  // A returning reader, who opens the chat to type.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); localStorage.setItem('cw.lead-chat.mode', 'chat'); } catch {}`,
  });
  return cdp;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-composer-'));
  let handle: ServerHandle | undefined;
  try {
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
    const made = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harborlight', author: ALICE }),
    });
    const ws = ((await made.json()) as { workspace: { id: string } }).workspace.id;
    server.tasks.attachAgent(ws, { ...LEAD, runtime: 'claude-code-local' });
    server.tasks.setLeadAgent(ws, LEAD.agentId, { actor: ALICE });
    const report = (body: unknown) =>
      fetch(`${base}/workspaces/${ws}/agents/${encodeURIComponent(LEAD.agentName)}/mirror`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const homeUrl = `${base}/workspaces/${ws}/home`;
    const cases: ComposerCase[] = [];

    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      await report({ kind: 'model', model: 'claude-haiku-5-5', effort: 'low' });
      const { cdp, port } = await openBrowser(width, height);
      const shot = async (name: string): Promise<void> => {
        if (!SHOTS) return;
        const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
          data: string;
        };
        writeFileSync(join(SHOTS, `${width}-${name}.png`), Buffer.from(data, 'base64'));
      };
      const opened = (await (
        await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(homeUrl)}`, {
          method: 'PUT',
        })
      ).json()) as { webSocketDebuggerUrl: string };
      const other = await pageAt(port, opened.webSocketDebuggerUrl, width, height);
      const open = async (page: Cdp): Promise<void> => {
        // A tab behind another never finishes its animation.
        await page.send('Page.bringToFront');
        const loaded = page.once('Page.loadEventFired');
        await page.send('Page.navigate', { url: homeUrl });
        await loaded;
        await until('the agent button', () =>
          page.evaluate(
            `!!document.querySelector('[data-lead-chat="button"]')?.shadowRoot?.querySelector('button')?.getBoundingClientRect().width`,
          ),
        );
        await page.evaluate(
          `document.querySelector('[data-lead-chat="button"]').shadowRoot.querySelector('button').click()`,
        );
        await until('the panel, its animation done', () =>
          page.evaluate(
            `(${box('.lc-box')})?.w > 0 && ${SR}.querySelector('.lc-pane').getAnimations().length === 0`,
          ),
        );
      };
      await open(cdp);
      await open(other);
      // A new tab comes to the front, and a hidden tab does not load a lazy image.
      await cdp.send('Page.bringToFront');

      const readBox = async (q: string, on = cdp) =>
        until(q, () => on.evaluate(box(q)) as Promise<Box | null>);
      await until('the chip reads the lead', () =>
        cdp.evaluate(`${SR}.querySelector('.lc-chip').textContent.includes('Haiku')`),
      );
      await shot('rest');
      const rest = await readBox('.lc-box');
      await cdp.evaluate(FIRE('dragenter'));
      await cdp.evaluate(FIRE('dragover'));
      const dragged = await readBox('.lc-box');
      const outline = String(
        await cdp.evaluate(`getComputedStyle(${SR}.querySelector('.lc-box')).outlineStyle`),
      );
      await shot('drag');
      await cdp.evaluate(FIRE('drop'));
      await until('both chips', () =>
        cdp.evaluate(
          `${SR}.querySelectorAll('.lc-att').length === 2 && !${SR}.querySelector('.lc-send').disabled`,
        ),
      );
      const chips = Number(await cdp.evaluate(`${SR}.querySelectorAll('.lc-att').length`));
      await shot('tray');
      await cdp.evaluate(`${SR}.querySelector('.lc-round').click()`);
      await shot('add-sheet');
      await cdp.evaluate(`${SR}.querySelector('.lc-scrim').click()`);
      await cdp.evaluate(`${SR}.querySelector('.lc-chip').click()`);
      const chipOpenedNothing = Boolean(
        await cdp.evaluate(`${SR}.querySelector('.lc-scrim').hidden`),
      );
      const sendEnabledWithNoWords = !(await cdp.evaluate(
        `${SR}.querySelector('.lc-send').disabled`,
      ));
      const row = (await cdp.evaluate(READ_ROW)) as string[];
      const rowOverflows = Boolean(await cdp.evaluate(OVERFLOW));
      const chipBefore = await readBox('.lc-chip');
      await cdp.evaluate(`${SR}.querySelector('.lc-send').click()`);
      const sent = await until('the thumbnail loads', async () => {
        const s = (await cdp.evaluate(SENT)) as ComposerCase['sent'];
        return s.thumbs === 1 && s.loaded ? s : null;
      });
      await shot('sent');
      const otherTab = await until('the other tab', async () => {
        const s = (await other.evaluate(SENT)) as ComposerCase['otherTab'];
        return s.thumbs === 1 ? s : null;
      });

      await report({ kind: 'model', model: 'claude-sonnet-5-5', effort: 'xhigh' });
      await until('the chip follows', () =>
        cdp.evaluate(`${SR}.querySelector('.lc-chip').textContent.includes('X-high')`),
      );
      const chipAfter = await readBox('.lc-chip');
      const chipText = String(await cdp.evaluate(`${SR}.querySelector('.lc-chip').textContent`));
      cases.push({
        width,
        rest,
        dragged,
        outline,
        chips,
        sendEnabledWithNoWords,
        row,
        rowOverflows,
        sent,
        otherTab,
        chipOpenedNothing,
        chipBefore,
        chipAfter,
        chipText,
      });
      other.close();
      cdp.close();
    }
    process.stdout.write(`${JSON.stringify({ cases } satisfies ComposerRun)}\n`);
  } finally {
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    },
  );
}
