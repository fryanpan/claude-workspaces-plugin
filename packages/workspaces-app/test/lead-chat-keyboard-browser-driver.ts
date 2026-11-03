#!/usr/bin/env bun
/**
 * The lead chat with the on-screen keyboard up, in headless Chromium against
 * a real server and the real bundles, at 430x932 and at 1180x820.
 *
 * A desktop browser has no on-screen keyboard, so the page's
 * `window.visualViewport` is replaced before any script runs by one whose
 * height and offset the driver sets. That is all iOS changes when its
 * keyboard comes up: the layout viewport, which `position: fixed` and
 * `innerHeight` follow, stays the full height, and only the visual viewport
 * shrinks and, when Safari pans to the focused field, moves down. Layout,
 * hit-testing and the chat's own code all run for real.
 *
 * With the chat open and the composer focused, the driver reads where the
 * composer is and which element is on top at points across the band that is
 * still visible: every one has to be the chat. Then it puts the keyboard
 * away and reads the panel again.
 *
 * Spawned by `lead-chat-keyboard-browser.test.ts`, which reads the JSON it
 * prints. `LEAD_CHAT_SHOTS=<dir>` also writes a screenshot of each state.
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
import { LeadChatLog } from '../../server/src/lead-chat/log.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';
import type { KeyboardBand, KeyboardRun } from './lead-chat-keyboard-browser-reading.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-keyboard] ${what}\n`);
};

async function until<T>(
  what: string,
  read: () => Promise<T | null> | T | null,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined && v !== false) return v;
    await sleep(25);
  }
  throw new Error(`never happened: ${what}`);
}

/** Installed before the page's scripts: a visual viewport the driver moves. */
const FAKE_VIEWPORT = `(() => {
  const vv = new EventTarget();
  let h = null, top = 0;
  Object.defineProperties(vv, {
    height: { get: () => h ?? innerHeight }, width: { get: () => innerWidth },
    offsetTop: { get: () => top }, offsetLeft: { get: () => 0 },
    pageTop: { get: () => top + scrollY }, pageLeft: { get: () => 0 }, scale: { get: () => 1 },
  });
  Object.defineProperty(window, 'visualViewport', { get: () => vv, configurable: true });
  window.__keyboard = (height, offset) => {
    h = height ?? null; top = offset ?? 0;
    vv.dispatchEvent(new Event('resize'));
    vv.dispatchEvent(new Event('scroll'));
  };
  try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}
})()`;

const SR = `document.querySelector('[data-lead-chat="layer"]')?.shadowRoot`;

/** What the page shows in the band the reader can see. */
const READ_BAND = `(() => {
  const vv = window.visualViewport;
  const top = vv.offsetTop, bottom = vv.offsetTop + vv.height;
  const sr = ${SR};
  const pane = sr.querySelector('.lc-pane');
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; };
  const layer = document.querySelector('[data-lead-chat="layer"]');
  const misses = [];
  for (let y = Math.ceil(top) + 2; y < bottom - 1; y += 16) {
    for (const x of [4, Math.round(innerWidth / 2), innerWidth - 4]) {
      const hit = document.elementFromPoint(x, y);
      if (hit !== layer) misses.push(x + ',' + y + ' ' + (hit ? hit.tagName.toLowerCase() + '.' + [...hit.classList].join('.') : 'none'));
    }
  }
  const nav = document.querySelector('.board-nav');
  return {
    band: { top: Math.round(top), bottom: Math.round(bottom) },
    pane: box(pane),
    composer: box(sr.querySelector('.lc-compose textarea')),
    focused: sr.activeElement === sr.querySelector('.lc-compose textarea'),
    misses: misses.slice(0, 12),
    missCount: misses.length,
    navTop: nav ? Math.round(nav.getBoundingClientRect().top) : null,
    listGap: (() => { const l = sr.querySelector('.lc-list'); return Math.round(l.scrollHeight - l.scrollTop - l.clientHeight); })(),
    innerHeight,
  };
})()`;

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function openBrowser(width: number, height: number): Promise<Cdp> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile, ['--mute-audio']),
    STARTUP_TIMEOUT_MS,
    `lead-chat-keyboard-${width}-${process.pid}`,
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
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_VIEWPORT });
  return cdp;
}

async function tap(cdp: Cdp, x: number, y: number): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
    });
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-keyboard-'));
  const shots = process.env.LEAD_CHAT_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let handle: ServerHandle | undefined;
  try {
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    step('build the app bundles');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`app build failed:\n${built.stderr}`);
    const dataDir = join(dir, 'data');
    handle = createServer({
      port: 0,
      dataDir,
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const res = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harborlight', author: ALICE }),
    });
    const ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
    handle.tasks.attachAgent(ws, { ...LEAD, runtime: 'claude-code-local' });
    handle.tasks.setLeadAgent(ws, LEAD.agentId, { actor: ALICE });
    // Enough conversation to fill the panel, so the list has to scroll.
    const log = new LeadChatLog(dataDir);
    const t0 = Date.now() - 60_000;
    for (let i = 0; i < 12; i++) {
      log.append(ws, {
        id: `m${i}`,
        role: i % 2 ? 'agent' : 'person',
        author: i % 2 ? { id: LEAD.agentId, name: LEAD.agentName } : ALICE,
        text: `Line ${i} about the Saltmarsh deploy, long enough to wrap onto a second line.`,
        ts: t0 + i,
        ...(i % 2
          ? { replyTo: `m${i - 1}` }
          : { via: 'chat' as const, state: 'answered' as const }),
      });
    }

    const run: KeyboardRun = { widths: [] };
    for (const [width, height, keyboard] of [
      [430, 932, [336, 0]],
      [430, 932, [336, 260]],
      [1180, 820, [398, 0]],
    ] as const) {
      const label = `${width}${keyboard[1] ? '-panned' : ''}`;
      step(`open the chat at ${label}`);
      const cdp = await openBrowser(width, height);
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `${base}/workspaces/${ws}` });
      await loaded;
      const at = await until('the agent button', async () => {
        const r = (await cdp.evaluate(`(() => {
          const b = document.querySelector('[data-lead-chat="button"]')?.shadowRoot?.querySelector('button');
          const r = b?.getBoundingClientRect();
          return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        })()`)) as { x: number; y: number } | null;
        return r;
      });
      await tap(cdp, at.x, at.y);
      await until('the panel open with its messages', async () =>
        (await cdp.evaluate(
          `(() => { const sr = ${SR}; const p = sr?.querySelector('.lc-pane'); return !!p && !p.hidden && sr.querySelectorAll('.lc-msg').length >= 12 && p.getAnimations().length === 0; })()`,
        ))
          ? true
          : null,
      );
      const shot = async (name: string): Promise<void> => {
        if (!shots) return;
        const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
          data: string;
        };
        writeFileSync(join(shots, `${name}-${label}.png`), Buffer.from(png.data, 'base64'));
      };
      const band = async (): Promise<KeyboardBand> =>
        (await cdp.evaluate(READ_BAND)) as KeyboardBand;
      const before = await band();
      await shot('lead-chat-keyboard-closed');

      step(`keyboard up at ${label}`);
      await cdp.evaluate(`${SR}.querySelector('.lc-compose textarea').focus()`);
      const [kb, pan] = keyboard;
      await cdp.evaluate(`window.__keyboard(${height - kb - pan}, ${pan})`);
      // Placed on the viewport's events; read once a frame has drawn it.
      await cdp.evaluate(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
      );
      const up = await band();
      await shot('lead-chat-keyboard-up');

      step(`keyboard down at ${label}`);
      await cdp.evaluate('window.__keyboard()');
      await cdp.evaluate(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
      );
      const down = await band();
      run.widths.push({ width, label, before, up, down });
      cdp.close();
    }
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
