#!/usr/bin/env bun
/**
 * The line that shows what the listener has heard, in headless Chromium
 * against a real server and the real bundles, at 1180x820 and 430x932. A
 * scripted listener feeds one growing transcript over the voice socket, and
 * after each step this driver reads, from the page's layout, whether the
 * newest word sits inside what the line clips to. Reading the text would pass
 * on a line that hides it: the words stay in the DOM past the clip.
 *
 * Two places show the line: the bar in Voice first and the status under the
 * chat's list in Chat first. No real device and no billed engine: Chrome's
 * fake microphone, muted output, a scripted listener.
 *
 * Spawned by `lead-chat-heard-browser.test.ts`, which reads the JSON it prints.
 * `LEAD_CHAT_SHOTS=<dir>` also writes a screenshot of the last step.
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
import type { EngineTurn, TranscriptionEngine } from '../../server/src/transcribe.ts';
import { agentStream } from '../../server/test/agent-voice-stream.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One read of the line. */
export interface LineRead {
  /** The word this step was waiting for. */
  word: string;
  /** The line's own box, and the box of the chat around it. */
  line: Box;
  around: Box;
  /** The transcript's first and newest words, each wholly inside every clip
   *  between it and the line. */
  firstVisible: boolean;
  lastVisible: boolean;
  /** Where the transcript's first word starts when it is visible. */
  firstLeft: number;
  /** "You:" or "Heard:", and whether it is wholly inside the line. */
  labelVisible: boolean;
  /** The computed mask on the clip: anything but "none" is the left-edge fade. */
  fade: string;
}

export interface HeardRun {
  width: number;
  place: 'bar' | 'status';
  /** The line before a word was heard, saying "Listening…". */
  idle: LineRead;
  steps: LineRead[];
  /** The bar at 1180 only: a line that fits, then the same line on a page
   *  narrowed to 430 with no new word heard. */
  narrowed?: { before: LineRead; after: LineRead };
}

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const step = (what: string): void => void process.stderr.write(`[lead-chat-heard] ${what}\n`);

/** Numbered so that each word is found once, and "word1" is not inside "word12". */
const WORD_COUNT = 64;
const wordsTo = (n: number): string =>
  Array.from({ length: n }, (_, i) => `ferry${String(i + 1).padStart(2, '0')}`).join(' ');
/** Fits on every line, then past the phone's line, then past the wide one. */
const GROWTH = [2, 8, 16, 32, 48, WORD_COUNT];

/** Every box between a text range and its line, intersected. */
const READ_LINE = (place: HeardRun['place'], word: string): string => `(() => {
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  if (!sr) return null;
  const around = sr.querySelector(${JSON.stringify(place === 'bar' ? '.lc-bar' : '.lc-pane')});
  const line = sr.querySelector(${JSON.stringify(place === 'bar' ? '.lc-bar-line:last-child' : '.lc-status')});
  if (!line || !around || around.hidden || !line.textContent.includes(${JSON.stringify(word)})) return null;
  // Read once the panel's grow has finished: mid-grow its box is the button's.
  if (around.getAnimations().length > 0) return null;
  const box = (r) => ({ left: r.left, top: r.top, width: r.width, height: r.height });
  const seen = (needle) => {
    const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const at = n.data.indexOf(needle);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(n, at);
      range.setEnd(n, at + needle.length);
      const r = range.getBoundingClientRect();
      let left = -Infinity, right = Infinity;
      for (let el = n.parentElement; el; el = el === line ? null : el.parentElement) {
        if (getComputedStyle(el).overflowX === 'visible') continue;
        const c = el.getBoundingClientRect();
        left = Math.max(left, c.left);
        right = Math.min(right, c.right);
      }
      return { left: r.left, visible: r.left >= left - 0.5 && r.right <= right + 0.5 };
    }
    return { left: NaN, visible: false };
  };
  const first = seen('ferry01');
  const label = seen(${JSON.stringify(place === 'bar' ? 'You:' : 'Heard:')});
  const clip = line.querySelector('.lc-tail-clip');
  return {
    word: ${JSON.stringify(word)},
    line: box(line.getBoundingClientRect()),
    around: box(around.getBoundingClientRect()),
    firstVisible: first.visible,
    lastVisible: seen(${JSON.stringify(word)}).visible,
    firstLeft: first.left,
    labelVisible: label.visible,
    fade: clip ? getComputedStyle(clip).maskImage : 'none',
  };
})()`;

const BUTTON = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const b = host?.shadowRoot?.querySelector('button')?.getBoundingClientRect();
  return b && b.width > 0 ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
})()`;

async function click(cdp: Cdp, at: { x: number; y: number }): Promise<void> {
  const press = { ...at, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...press });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...press });
}

async function until<T>(what: string, read: () => Promise<T | null>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

/** A browser of its own for each run: listening survives a page load. */
async function openBrowser(width: number, height: number, mode: string): Promise<Cdp> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) =>
      chromeLaunchArgs({ width, height }, profile, [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--mute-audio',
      ]),
    STARTUP_TIMEOUT_MS,
    `lead-chat-heard-${width}-${mode}-${process.pid}`,
    (started) => void browsers.push(started),
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
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); localStorage.setItem('cw.lead-chat.mode', '${mode}'); } catch {}`,
  });
  return cdp;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-heard-'));
  const shots = process.env.LEAD_CHAT_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let handle: ServerHandle | undefined;
  let lead: Awaited<ReturnType<typeof agentStream>> | undefined;
  try {
    step('build the bundles');
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`app build failed:\n${built.stderr}`);

    let hear: ((turn: EngineTurn) => void) | null = null;
    const listener: TranscriptionEngine = {
      name: 'scripted',
      async open(o) {
        hear = o.onTurn;
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
    const base = `http://127.0.0.1:${handle.port}`;
    const res = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Riverbend',
        author: { id: 'agent-riverbend', name: 'Riverbend notes', kind: 'agent' },
      }),
    });
    const ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
    handle.tasks.attachAgent(ws, { ...LEAD, runtime: 'claude-code-local' });
    handle.tasks.setLeadAgent(ws, LEAD.agentId, {
      actor: { id: 'known-alice', name: 'Alice', kind: 'known' },
    });
    lead = await agentStream(base, ws, LEAD.agentId);

    const runs: HeardRun[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      for (const place of ['bar', 'status'] as const) {
        step(`${place} at ${width}`);
        const cdp = await openBrowser(width, height, place === 'bar' ? 'voice' : 'chat');
        const loaded = cdp.once('Page.loadEventFired');
        await cdp.send('Page.navigate', { url: `${base}/workspaces/${ws}` });
        await loaded;
        const at = await until(
          'the agent button',
          async () => (await cdp.evaluate(BUTTON)) as { x: number; y: number } | null,
        );
        hear = null;
        await click(cdp, at);
        const idle = await until(
          'the line saying Listening…',
          async () => (await cdp.evaluate(READ_LINE(place, 'Listening'))) as LineRead | null,
        );
        await until('the listener open', async () => hear);
        const steps: LineRead[] = [];
        for (const n of GROWTH) {
          const word = `ferry${String(n).padStart(2, '0')}`;
          steps.push(
            await until(`the line reaching ${word}`, async () => {
              // The page may reopen its listener; a real one repeats a partial.
              hear?.({ turn: 0, text: wordsTo(n), final: false });
              return (await cdp.evaluate(READ_LINE(place, word))) as LineRead | null;
            }),
          );
        }
        let narrowed: HeardRun['narrowed'];
        if (place === 'bar' && width === 1180) {
          const fits = 'ferry08';
          const before = await until('a line that fits', async () => {
            hear?.({ turn: 0, text: wordsTo(8), final: false });
            const r = (await cdp.evaluate(READ_LINE(place, fits))) as LineRead | null;
            return r?.lastVisible && r.firstVisible ? r : null;
          });
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 430,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          const after = await until('the fade after the page narrowed', async () => {
            const r = (await cdp.evaluate(READ_LINE(place, fits))) as LineRead | null;
            return r && r.fade !== 'none' ? r : null;
          });
          narrowed = { before, after };
        }
        if (shots) {
          const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
            data: string;
          };
          writeFileSync(
            join(shots, `heard-${place}-${width}.png`),
            Buffer.from(png.data, 'base64'),
          );
        }
        runs.push({ width, place, idle, steps, ...(narrowed ? { narrowed } : {}) });
        cdp.close();
        // A browser left open keeps listening, and its listener would take `hear`.
        const open = browsers.pop();
        if (open) await stopBrowser(open.proc, open.profile);
      }
    }
    process.stdout.write(`\n${JSON.stringify(runs)}\n`);
  } finally {
    lead?.close();
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
