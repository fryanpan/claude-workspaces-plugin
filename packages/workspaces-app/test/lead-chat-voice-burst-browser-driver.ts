#!/usr/bin/env bun
/**
 * Four `answer_voice` replies inside two seconds, to one open doc page with
 * the chat panel open, in headless Chromium against a real server and the
 * real bundles, at 1180x820 and 430x932 (Bryan, 4 Nov: "your voice answers
 * are not playing").
 *
 * The reader asks four questions by voice, so four answers are owed. Then:
 *
 * - `quiet`: the next listener has heard nothing while the answers arrive,
 *   and each answer's audio is all sent before the next arrives, so the page
 *   holds audio it has not played yet when the next one starts.
 * - `slow`: the same with a voice still sending one answer when the next
 *   arrives.
 * - `talking`: the reader is mid-sentence when they arrive, and finishes
 *   after the last one.
 *
 * "Played" is read from the page's own audio graph. Each answer's fake voice
 * sends three chunks of PCM at a level that names the answer, and a wrapper
 * round `AudioBufferSourceNode` records every chunk's start time, whether it
 * ran to its end, and whether it was stopped. No real device and no billed
 * engine: Chrome's fake microphone, muted output, a listener the driver
 * speaks through.
 *
 * Spawned by `lead-chat-voice-burst-browser.test.ts`, which reads the JSON it
 * prints.
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
import type { SpokenVoice } from '../../server/src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../../server/src/transcribe.ts';
import { agentStream } from '../../server/test/agent-voice-stream.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };
/** The gap between answers: four of them inside two seconds. */
const ANSWER_GAP_MS = 400;
/** The fake voice's delay before its first audio, as a real voice connects. */
const VOICE_CONNECT_MS = 150;
const CHUNKS = 3;
/** The gap between a voice's chunks, by way: `slow` outlasts `ANSWER_GAP_MS`. */
const CHUNK_GAP_MS = { quiet: 10, slow: 200, talking: 10 } as const;
/** 0.2s of PCM at the spoken output rate. */
const CHUNK_SAMPLES = 4800;
/** PCM level of answer `n` is `n * LEVEL_STEP`. */
const LEVEL_STEP = 3000;
/** How long the four answers may take to finish once sent. */
const PLAY_MS = 10_000;

export type BurstWay = keyof typeof CHUNK_GAP_MS;

export interface BurstChunk {
  /** Which answer this chunk belongs to, 1 to 4. */
  answer: number;
  /** When the page scheduled it to start, on the audio clock, in seconds. */
  at: number;
  seconds: number;
  ended: boolean;
  stopped: boolean;
}

export interface BurstCase {
  width: number;
  way: BurstWay;
  /** Each `answer_voice`'s `delivered`. */
  delivered: boolean[];
  /** The milliseconds from the first answer sent to the last. */
  sentWithinMs: number;
  chunks: BurstChunk[];
  /** Voice is still on, and a new listener opened after the last answer. */
  listensAgain: boolean;
}

export interface BurstRun {
  chunksPerAnswer: number;
  cases: BurstCase[];
}

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-voice-burst-driver] ${what}\n`);
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

/** Runs before the page's own scripts: records what the page plays. */
const RECORD_PLAYBACK = `(() => {
  const start = AudioBufferSourceNode.prototype.start;
  const stop = AudioBufferSourceNode.prototype.stop;
  const said = [];
  window.__said = said;
  AudioBufferSourceNode.prototype.start = function (when, ...rest) {
    const level = this.buffer ? this.buffer.getChannelData(0)[0] * 32768 : 0;
    const row = {
      answer: Math.round(level / ${LEVEL_STEP}),
      at: when ?? 0,
      seconds: this.buffer ? this.buffer.duration : 0,
      ended: false,
      stopped: false,
    };
    if (row.answer > 0) said.push(row);
    this.__row = row;
    this.addEventListener('ended', () => { row.ended = true; });
    return start.call(this, when, ...rest);
  };
  AudioBufferSourceNode.prototype.stop = function (...args) {
    if (this.__row) this.__row.stopped = true;
    return stop.apply(this, args);
  };
})();`;

const BUTTON = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const b = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
})()`;

const BAR = `(() => {
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const el = sr && sr.querySelector('.lc-bar');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 ? { x: r.left + Math.min(r.width / 2, 12), y: r.top + r.height / 2 } : null;
})()`;

const STATE = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const b = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const pane = sr && sr.querySelector('.lc-pane');
  return {
    listening: !!b && b.dataset.listening === 'true',
    paneOpen: !!pane && !pane.hidden && pane.getBoundingClientRect().width > 0,
  };
})()`;

type XY = { x: number; y: number };
const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function openBrowser(width: number, height: number): Promise<Cdp> {
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
    `lead-chat-voice-burst-${width}-${process.pid}`,
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
  // A returning reader on a Voice first device: the first tap listens.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); localStorage.setItem('cw.lead-chat.mode', 'voice'); } catch {}`,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORD_PLAYBACK });
  return cdp;
}

async function tap(cdp: Cdp, at: XY): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: at.x,
      y: at.y,
      button: 'left',
      clickCount: 1,
    });
  }
}

let chunkGapMs: number = CHUNK_GAP_MS.quiet;

/** Says "Answer n." as `CHUNKS` chunks at the level that names `n`; anything
 *  else, such as a filler cue, as silence, which the page's record skips. */
const levelVoice: SpokenVoice = {
  name: 'levels',
  async speak(text, onAudio, signal) {
    await sleep(VOICE_CONNECT_MS);
    const n = Number(/^Answer (\d)\.$/.exec(text.trim())?.[1] ?? 0);
    const pcm = new Int16Array(CHUNK_SAMPLES).fill(n * LEVEL_STEP);
    for (let i = 0; i < CHUNKS; i++) {
      if (signal?.aborted) return;
      onAudio(new Uint8Array(pcm.buffer.slice(0)));
      await sleep(chunkGapMs);
    }
  },
};

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-voice-burst-'));
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
    const opened: TranscriptionOpenOpts[] = [];
    const listener: TranscriptionEngine = {
      name: 'driver',
      async open(opts) {
        opened.push(opts);
        return { send: () => {}, close: async () => {} };
      },
    };
    handle = createServer({
      spokenReply: { listener, voices: { 1: levelVoice, 2: null }, gemini: null } as never,
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const server = handle;
    const base = `http://127.0.0.1:${server.port}`;
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const made = await post('/workspaces', { name: 'Harborlight', author: ALICE });
    if (!made.ok) throw new Error(`/workspaces: ${made.status} ${await made.text()}`);
    const ws = ((await made.json()) as { workspace: { id: string } }).workspace.id;
    server.tasks.attachAgent(ws, { ...LEAD, runtime: 'claude-code-local' });
    server.tasks.setLeadAgent(ws, LEAD.agentId, { actor: ALICE });
    lead = await agentStream(base, ws, LEAD.agentId);
    const stream = lead;
    const plan = join(dir, 'riverbend-summary.md');
    writeFileSync(plan, '# Riverbend summary\n');
    const doc = await post(`/workspaces/${ws}/docs`, {
      docId: 'riverbend-summary',
      type: 'markdown',
      title: 'Riverbend summary',
      sourceUrl: plan,
    });
    if (!doc.ok) throw new Error(`/docs: ${doc.status} ${await doc.text()}`);
    const docId = String(((await doc.json()) as { docId: string }).docId);
    const docUrl = `${base}/workspaces/${ws}/docs/${docId}`;

    const cases: BurstCase[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      const cdp = await openBrowser(width, height);
      const state = async () =>
        (await cdp.evaluate(STATE)) as { listening: boolean; paneOpen: boolean };
      for (const way of ['quiet', 'slow', 'talking'] as const) {
        step(`${way} at ${width}`);
        chunkGapMs = CHUNK_GAP_MS[way];
        // A fresh tab state for each case: voice is not carried on from the last.
        for (let i = 0; i < 2; i++) {
          if (i === 1) await cdp.evaluate('sessionStorage.clear()');
          const loaded = cdp.once('Page.loadEventFired');
          await cdp.send('Page.navigate', { url: docUrl });
          await loaded;
        }
        const button = await until(
          'the agent button',
          async () => (await cdp.evaluate(BUTTON)) as XY | null,
        );
        const before = opened.length;
        await tap(cdp, button);
        await until('listening', async () => ((await state()).listening ? true : null));
        await until('the listener opened', () => (opened.length > before ? true : null));
        const bar = await until('the bar', async () => (await cdp.evaluate(BAR)) as XY | null);
        await tap(cdp, bar);
        await until('the panel open', async () => ((await state()).paneOpen ? true : null));

        const queueIds: string[] = [];
        for (let n = 1; n <= 4; n++) {
          const asked = `Question ${n}, ${way} at ${width}?`;
          const listeners = opened.length;
          opened.at(-1)?.onTurn({ turn: 0, text: asked, final: true });
          const frame = await until(
            'the lead heard it',
            () => stream.voice.find((v) => v.transcript === asked) ?? null,
          );
          queueIds.push(String(frame.queueId));
          await until('the next listener', () => (opened.length > listeners ? true : null));
        }
        const ears = opened.at(-1);
        if (way === 'talking') ears?.onTurn({ turn: 0, text: 'and while you are', final: false });

        const delivered: boolean[] = [];
        const t0 = Date.now();
        let sentWithinMs = 0;
        for (const [i, queueId] of queueIds.entries()) {
          if (i > 0) await sleep(ANSWER_GAP_MS);
          const res = await post(`/workspaces/${ws}/voice-queue/${queueId}/answer`, {
            agentId: LEAD.agentId,
            text: `Answer ${i + 1}.`,
          });
          if (!res.ok) throw new Error(`answer: ${res.status} ${await res.text()}`);
          delivered.push(((await res.json()) as { delivered: boolean }).delivered);
          sentWithinMs = Date.now() - t0;
        }
        const listeners = opened.length;
        if (way === 'talking') {
          ears?.onTurn({ turn: 0, text: 'and while you are at it, thanks.', final: true });
        }
        const readChunks = async (): Promise<BurstChunk[]> =>
          (await cdp.evaluate('JSON.parse(JSON.stringify(window.__said))')) as BurstChunk[];
        await until(
          'all four answers to finish',
          async () => {
            const rows = await readChunks();
            return rows.length >= 4 * CHUNKS && rows.every((r) => r.ended) ? true : null;
          },
          PLAY_MS,
        ).catch(() => step(`${way} at ${width}: not all four finished`));
        const chunks = await readChunks();
        const listensAgain = await until(
          'a listener after the last answer',
          async () => ((await state()).listening && opened.length > listeners ? true : null),
          4000,
        ).catch(() => false);
        cases.push({ width, way, delivered, sentWithinMs, chunks, listensAgain });
      }
      cdp.close();
    }
    const run: BurstRun = { chunksPerAnswer: CHUNKS, cases };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    lead?.close();
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 280s');
  void Promise.all(browsers.map((b) => stopBrowser(b.proc, b.profile))).finally(() =>
    process.exit(3),
  );
}, 280_000).unref();
await main();
process.exit(0);
