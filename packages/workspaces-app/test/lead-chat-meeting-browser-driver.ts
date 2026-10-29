#!/usr/bin/env bun
/**
 * The lead chat's meeting in headless Chromium against a real server and the
 * real bundles, at 1180x820 and at 430x932: Start a meeting, the wizard,
 * Start meeting; the microphone streams to the doc's meeting socket; a line
 * the engine hears shows in the live notes on the recording page AND on a
 * second tab that is only watching; the recording tab moves page by page
 * across the board (Tasks, Home, Library, the mock, the doc) and every page
 * resumes the same recording; End meeting on the watching tab stops it.
 *
 * What it measures per page move is the speech gap: the longest stretch in
 * which the engine received no audio, from the old page's last frame to the
 * new page's first, and how many of the new page's first frames came as one
 * burst (audio the page held while its socket reopened, so not lost).
 *
 * No real device and no billed engine: Chrome's fake microphone, muted
 * output, a scripted engine that records when each frame arrived and says
 * whatever line this driver hands it.
 *
 * Spawned by `lead-chat-meeting-browser.test.ts`, which reads the JSON it
 * prints. `LEAD_CHAT_SHOTS=<dir>` also writes screenshots.
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
import type { TranscriptionEngine } from '../../server/src/transcribe.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';
import type { MeetingBrowserRun, MeetingSizeRun, Rect } from './lead-chat-browser-reading.ts';

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-meeting-driver] ${what}\n`);
};

async function until<T>(
  what: string,
  read: () => Promise<T | null> | T | null,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(25);
  }
  throw new Error(`never happened: ${what}`);
}

/** The chat's meeting as the page shows it, through its shadow roots. */
const READ = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const q = (s) => sr && sr.querySelector(s);
  const box = (el) => { if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; };
  const nav = document.querySelector('.cw-host-nav');
  const frame = document.querySelector('iframe[data-cw-mock-frame]');
  const b = btn && btn.getBoundingClientRect();
  const hit = b ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
  return {
    button: box(btn),
    buttonOnTop: !!hit && hit === host,
    pane: box(q('.lc-pane')),
    start: box(q('.lc-start')),
    next: q('[data-wiz="next"]') && !q('[data-wiz="next"]').disabled ? box(q('[data-wiz="next"]')) : null,
    go: box(q('[data-wiz="start"]')),
    wizard: box(q('.lc-wiz')),
    head: box(q('.lc-meet')),
    headText: q('.lc-meet') && !q('.lc-meet').hidden ? q('.lc-meet').textContent : '',
    end: box(q('.lc-end')),
    tap: box(q('.lc-tap')),
    notes: q('.lc-notes') && !q('.lc-notes').hidden ? q('.lc-notes').textContent : '',
    nav: box(nav),
    navLinks: nav ? [...nav.querySelectorAll('a')].map((a) => a.textContent) : [],
    frame: box(frame),
    viewport: { width: document.documentElement.clientWidth, height: innerHeight },
  };
})()`;

interface Read {
  button: Rect | null;
  buttonOnTop: boolean;
  pane: Rect | null;
  start: Rect | null;
  next: Rect | null;
  go: Rect | null;
  wizard: Rect | null;
  head: Rect | null;
  headText: string;
  end: Rect | null;
  tap: Rect | null;
  notes: string;
  nav: Rect | null;
  navLinks: string[];
  frame: Rect | null;
  viewport: { width: number; height: number };
}

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function setup(cdp: Cdp, width: number, height: number): Promise<Cdp> {
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
  return cdp;
}

async function openBrowser(width: number, height: number) {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) =>
      chromeLaunchArgs({ width, height }, profile, [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--mute-audio',
      ]),
    STARTUP_TIMEOUT_MS,
    `lead-chat-meeting-${width}-${process.pid}`,
    (started) => {
      browsers.push(started);
    },
  );
  const main = await setup(
    await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS)),
    width,
    height,
  );
  // A second tab of the same browser: its own session storage, so it is not
  // the recorder — only a page watching the meeting.
  const res = await fetch(`http://127.0.0.1:${b.port}/json/new?about:blank`, { method: 'PUT' });
  const target = (await res.json()) as { webSocketDebuggerUrl: string };
  const watcher = await setup(await Cdp.connect(target.webSocketDebuggerUrl), width, height);
  return { main, watcher, browser: b };
}

async function read(cdp: Cdp): Promise<Read> {
  return (await cdp.evaluate(READ)) as Read;
}

async function go(cdp: Cdp, url: string): Promise<Read> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  return until('the agent button on the page', async () => {
    const r = await read(cdp);
    return r.button ? r : null;
  });
}

async function tap(cdp: Cdp, r: Rect): Promise<void> {
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

async function shot(cdp: Cdp, dir: string | undefined, name: string): Promise<void> {
  if (!dir) return;
  const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
  writeFileSync(join(dir, `${name}.png`), Buffer.from(png.data, 'base64'));
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-meeting-'));
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

    // Every audio frame the engine is sent, by when it arrived; `say` makes
    // the open session hear one settled line.
    const ear = {
      frames: [] as number[],
      opens: 0,
      say: null as ((text: string) => void) | null,
    };
    let turn = 0;
    const engine: TranscriptionEngine = {
      name: 'scripted',
      async open(o) {
        ear.opens++;
        ear.say = (text) => o.onTurn({ turn: turn++, text, final: true });
        return {
          send: () => {
            ear.frames.push(Date.now());
          },
          close: async () => {},
        };
      },
    };
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
      transcription: engine,
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
    const plan = join(dir, 'saltmarsh-plan.md');
    writeFileSync(plan, '# Saltmarsh signup\n');
    const doc = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'saltmarsh-plan',
          type: 'markdown',
          title: 'Saltmarsh plan',
          sourceUrl: plan,
        })
      ).docId,
    );
    const mockFile = join(dir, 'signup.html');
    writeFileSync(
      mockFile,
      '<!doctype html><html><head><title>Signup</title></head><body><h1>Join Saltmarsh</h1></body></html>',
    );
    const mock = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'signup-mock',
          type: 'mockup',
          sourceUrl: mockFile,
        })
      ).docId,
    );
    await post(`/workspaces/${ws}/docs:attach`, { docId: mock });
    const at = (p: string) => `${base}/workspaces/${ws}${p}`;
    const route: Array<[string, string]> = [
      ['tasks', at('')],
      ['home', at('/home')],
      ['library', at('/library')],
      ['mock', at(`/mockups/${mock}`)],
      ['doc', at(`/docs/${doc}`)],
    ];

    const sizes: MeetingSizeRun[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      step(`start a meeting at ${width}`);
      const { main: page, watcher, browser } = await openBrowser(width, height);
      const first = await go(page, at(`/docs/${doc}`));
      await tap(page, first.button as Rect);
      const open = await until('Start a meeting in the panel', async () => {
        const r = await read(page);
        return r.start && r.pane ? r : null;
      });
      await tap(page, open.start as Rect);
      const step1 = await until('the wizard, its docs read', async () => {
        const r = await read(page);
        return r.next ? r : null;
      });
      await shot(page, shots, `meeting-wizard-${width}`);
      await tap(page, step1.next as Rect);
      const step2 = await until('step 2', async () => {
        const r = await read(page);
        return r.go ? r : null;
      });
      const wizard = step2.wizard;
      await tap(page, step2.go as Rect);
      const n0 = ear.frames.length;
      await until('audio reaching the engine', () => (ear.frames.length > n0 + 10 ? true : null));
      const started = await until('the meeting heading', async () => {
        const r = await read(page);
        return r.head ? r : null;
      });
      await shot(page, shots, `meeting-heading-${width}`);

      step(`a second tab watches at ${width}`);
      await go(watcher, at(''));
      const watchOpen = await read(watcher);
      await tap(watcher, watchOpen.button as Rect);
      await until('the watcher shows the meeting', async () => {
        const r = await read(watcher);
        return r.head ? r : null;
      });
      const line = `The slipway opens at nine, said at ${width}.`;
      const said = Date.now();
      ear.say?.(line);
      await until('the line on the recording page', async () =>
        (await read(page)).notes.includes(line) ? true : null,
      );
      const recorderMs = Date.now() - said;
      await until('the line on the watching tab', async () =>
        (await read(watcher)).notes.includes(line) ? true : null,
      );
      const watcherMs = Date.now() - said;

      const moves: MeetingSizeRun['moves'] = [];
      for (const [surface, url] of route) {
        step(`move to ${surface} at ${width}`);
        const before = ear.frames.length;
        const opensBefore = ear.opens;
        const movedAt = Date.now();
        const landed = await go(page, url);
        // Resumed with no tap, or waiting for one.
        const state = await until(
          `the recording back on ${surface}`,
          async () => {
            if (ear.frames.length > before + 20 && (ear.frames.at(-1) ?? 0) > movedAt)
              return 'recording';
            const r = await read(page);
            return r.tap ? 'tap' : null;
          },
          20_000,
        );
        let tapped = false;
        if (state === 'tap') {
          tapped = true;
          const r = await read(page);
          await tap(page, r.tap as Rect);
          await until(`audio again on ${surface} after the tap`, () =>
            ear.frames.length > before + 20 ? true : null,
          );
        }
        const window = ear.frames.slice(Math.max(0, before - 1));
        let gap = 0;
        let gapAt = 0;
        for (let i = 1; i < window.length; i++) {
          const d = (window[i] ?? 0) - (window[i - 1] ?? 0);
          if (d > gap) {
            gap = d;
            gapAt = i;
          }
        }
        // The new page's opening burst: frames it held while its socket came
        // back, delivered together.
        const firstAfter = window[gapAt] ?? 0;
        const burst = window.slice(gapAt).filter((t) => t - firstAfter < 30).length;
        const after = await read(page);
        if (surface === 'mock') await shot(page, shots, `meeting-mock-${width}`);
        moves.push({
          surface,
          gapMs: gap,
          burstFrames: burst,
          tapped,
          engineReopened: ear.opens > opensBefore,
          headShown: after.head !== null,
          notesKept: after.notes.includes(line),
          paneOpen: after.pane !== null,
          ...(surface === 'mock'
            ? {
                nav: landed.nav,
                navLinks: landed.navLinks,
                frame: landed.frame,
                buttonOnTop: landed.buttonOnTop,
              }
            : {}),
        });
      }

      step(`End meeting from the watching tab at ${width}`);
      const w = await read(watcher);
      await tap(watcher, w.end as Rect);
      await until('the meeting gone on the recording page', async () => {
        const r = await read(page);
        return r.head === null ? true : null;
      });
      const stoppedAt = ear.frames.length;
      await sleep(600);
      const framesAfterEnd = ear.frames.length - stoppedAt;
      const snap = (await (await fetch(at('/lead-chat'))).json()) as { meeting: unknown };
      sizes.push({
        width,
        wizard,
        headText: started.headText,
        head: started.head,
        pane: started.pane,
        viewport: started.viewport,
        recorderMs,
        watcherMs,
        moves,
        framesAfterEnd,
        endedOnServer: snap.meeting === null,
      });
      page.close();
      watcher.close();
      // Closed, so its pages leave the board before the next size meets.
      await stopBrowser(browser.proc, browser.profile);
      const held = browsers.findIndex((x) => x.proc === browser.proc);
      if (held >= 0) browsers.splice(held, 1);
    }
    const run: MeetingBrowserRun = { sizes };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
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
