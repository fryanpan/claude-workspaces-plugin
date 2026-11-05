#!/usr/bin/env bun
/**
 * Listening switched on in two tabs, in headless Chromium against a real
 * server and the real bundles, at 1180x820 and 430x932 (Bryan, 4 Nov: "it's
 * fine to have listening turned on on multiple tabs. Um, but only the tab
 * that I'm actively on should be listening to me, or the last one that I was
 * on").
 *
 * Each size gets one browser with three tabs: two on the board's Home (A
 * and B) and one blank page that stands for any other tab. Listening is
 * turned on in A, then in B, each with a tap while it is in front. Then the
 * front tab changes three times — A, B, and the blank one, which leaves
 * neither board tab focused — and each time the driver counts the
 * microphone frames each board tab sends up its voice socket, and reads
 * what each shows.
 *
 * A count is taken over a window that ends when the tab expected to send
 * has sent `WINDOW_FRAMES` frames, so it waits on what it measures rather
 * than on a clock. A tab that should not send has had that whole window to
 * send one.
 *
 * No real device and no billed engine: Chrome's fake microphone, muted
 * output, a listener that drops what it is sent.
 *
 * Spawned by `lead-chat-voice-tabs-browser.test.ts`, which reads the JSON it
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
import type { SpokenVoice } from '../../server/src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../../server/src/transcribe.ts';
import { agentStream } from '../../server/test/agent-voice-stream.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };
/** Frames the sending tab sends in one counting window. */
const WINDOW_FRAMES = 25;

/** What one board tab shows of its chat. */
export interface VoiceTabRead {
  /** Listening is switched on: the agent button reads listening. */
  listening: boolean;
  /** The agent button says listening is paused. */
  paused: boolean;
  /** The bar's lines, and the panel's status line. */
  bar: string;
  status: string;
}

export interface VoiceTabPhase {
  /** The tab in front: a board tab, or the blank one (`none`). */
  front: 'A' | 'B' | 'none';
  /** Microphone frames each board tab sent in the window. */
  framesA: number;
  framesB: number;
  a: VoiceTabRead;
  b: VoiceTabRead;
}

export interface VoiceTabsCase {
  width: number;
  phases: VoiceTabPhase[];
}

export interface VoiceTabsRun {
  cases: VoiceTabsCase[];
}

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-voice-tabs-driver] ${what}\n`);
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

const READ = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  return {
    listening: btn ? btn.dataset.listening === 'true' : false,
    paused: btn ? btn.dataset.paused === 'true' : false,
    bar: sr && sr.querySelector('.lc-bar') ? sr.querySelector('.lc-bar').textContent : '',
    status: sr && sr.querySelector('.lc-status') ? sr.querySelector('.lc-status').textContent : '',
  };
})()`;

const BUTTON = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const b = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
})()`;

interface Tab {
  cdp: Cdp;
  /** Binary frames sent up this tab's voice socket. */
  frames: number;
}

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function newTab(port: number, width: number, height: number): Promise<Tab> {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const target = (await res.json()) as { webSocketDebuggerUrl: string };
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const tab: Tab = { cdp, frames: 0 };
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const voiceSockets = new Set<string>();
  cdp.on('Network.webSocketCreated', (p) => {
    const e = p as unknown as { requestId: string; url: string };
    if (e.url.includes('/voice/converse')) voiceSockets.add(e.requestId);
  });
  cdp.on('Network.webSocketFrameSent', (p) => {
    const e = p as unknown as { requestId: string; response: { opcode: number } };
    if (voiceSockets.has(e.requestId) && e.response.opcode === 2) tab.frames++;
  });
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  // A returning reader on a Voice first device.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); localStorage.setItem('cw.lead-chat.mode', 'voice'); } catch {}`,
  });
  return tab;
}

async function openBrowser(width: number, height: number): Promise<{ port: number; blank: Cdp }> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) =>
      chromeLaunchArgs({ width, height }, profile, [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--mute-audio',
        '--autoplay-policy=no-user-gesture-required',
      ]),
    STARTUP_TIMEOUT_MS,
    `lead-chat-voice-tabs-${width}-${process.pid}`,
    (started) => {
      browsers.push(started);
    },
  );
  const blank = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
  await blank.send('Page.enable');
  return { port: b.port, blank };
}

type Mouse = 'mousePressed' | 'mouseReleased';
async function tap(cdp: Cdp, at: { x: number; y: number }): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased'] as Mouse[]) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: at.x,
      y: at.y,
      button: 'left',
      clickCount: 1,
    });
  }
}

const read = async (cdp: Cdp): Promise<VoiceTabRead> => (await cdp.evaluate(READ)) as VoiceTabRead;

async function front(cdp: Cdp): Promise<void> {
  await cdp.send('Page.bringToFront');
  await until('the tab in front has focus', async () =>
    (await cdp.evaluate('document.hasFocus()')) === true ? true : null,
  );
}

/** Frames each tab sends while `sender` sends `WINDOW_FRAMES`: one window
 *  to let the change land, then the one that is counted. */
async function countWindow(a: Tab, b: Tab, sender: Tab): Promise<[number, number]> {
  let window: [number, number] = [0, 0];
  for (const counted of [false, true]) {
    const fromA = a.frames;
    const fromB = b.frames;
    const fromS = sender.frames;
    await until(
      `${WINDOW_FRAMES} frames from the tab that should hear`,
      () => (sender.frames - fromS >= WINDOW_FRAMES ? true : null),
      15_000,
    );
    if (counted) window = [a.frames - fromA, b.frames - fromB];
  }
  return window;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-voice-tabs-'));
  const shots = process.env.LEAD_CHAT_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let handle: ServerHandle | undefined;
  let lead: Awaited<ReturnType<typeof agentStream>> | undefined;
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
    const listener: TranscriptionEngine = {
      name: 'quiet',
      async open() {
        return { send: () => {}, close: async () => {} };
      },
    };
    const quiet: SpokenVoice = {
      name: 'quiet',
      speak: async (_t, onAudio) => onAudio(new Uint8Array(480)),
    };
    handle = createServer({
      spokenReply: { listener, voices: { 1: quiet, 2: null }, gemini: null } as never,
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const server = handle;
    const base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harborlight', author: ALICE }),
    });
    if (!res.ok) throw new Error(`/workspaces: ${res.status} ${await res.text()}`);
    const ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
    server.tasks.attachAgent(ws, { ...LEAD, runtime: 'claude-code-local' });
    server.tasks.setLeadAgent(ws, LEAD.agentId, { actor: ALICE });
    lead = await agentStream(base, ws, LEAD.agentId);
    const homeUrl = `${base}/workspaces/${ws}/home`;

    const cases: VoiceTabsCase[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      const { port, blank } = await openBrowser(width, height);
      const a = await newTab(port, width, height);
      const b = await newTab(port, width, height);
      for (const [name, tab] of [
        ['A', a],
        ['B', b],
      ] as const) {
        step(`listening on in tab ${name}, at ${width}`);
        await front(tab.cdp);
        const loaded = tab.cdp.once('Page.loadEventFired');
        await tab.cdp.send('Page.navigate', { url: homeUrl });
        await loaded;
        const btn = await until('the agent button', async () => {
          return (await tab.cdp.evaluate(BUTTON)) as { x: number; y: number } | null;
        });
        // Voice first: the first tap brings the bar out and listens.
        await tap(tab.cdp, btn);
        await until(`tab ${name} listening`, async () =>
          (await read(tab.cdp)).listening ? true : null,
        );
        await until(`tab ${name} sending`, () => (tab.frames > 0 ? true : null));
      }
      const phases: VoiceTabPhase[] = [];
      for (const [name, cdp, sender] of [
        ['A', a.cdp, a],
        ['B', b.cdp, b],
        ['none', blank, b],
      ] as const) {
        step(`${name} in front, at ${width}`);
        await front(cdp);
        // -1: the tab that should hear sent too little to close a window.
        const [framesA, framesB] = await countWindow(a, b, sender).catch(
          () => [-1, -1] as [number, number],
        );
        const phase: VoiceTabPhase = {
          front: name,
          framesA,
          framesB,
          a: await read(a.cdp),
          b: await read(b.cdp),
        };
        phases.push(phase);
        step(JSON.stringify(phase));
        if (shots) {
          for (const [t, tab] of [
            ['a', a],
            ['b', b],
          ] as const)
            await shot(tab.cdp, join(shots, `voice-tabs-${width}-${name}-front-${t}.png`));
        }
      }
      cases.push({ width, phases });
      a.cdp.close();
      b.cdp.close();
      blank.close();
    }
    const run: VoiceTabsRun = { cases };
    // Drain before exit: a line cut off at the pipe's buffer is no JSON.
    await new Promise<void>((r) => process.stdout.write(`\n${JSON.stringify(run)}\n`, () => r()));
  } finally {
    lead?.close();
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function shot(cdp: Cdp, path: string): Promise<void> {
  const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
  writeFileSync(path, Buffer.from(png.data, 'base64'));
}

setTimeout(() => {
  step('gave up after 230s');
  void Promise.all(browsers.map((b) => stopBrowser(b.proc, b.profile))).finally(() =>
    process.exit(3),
  );
}, 230_000).unref();
await main();
process.exit(0);
