#!/usr/bin/env bun
/**
 * The lead chat listening on a mock's page while the mock, sandboxed in its
 * frame, speaks a turn call with `speechSynthesis`, and then while the host
 * page itself speaks one: headless Chromium against a real server and the
 * real bundles, at 1180x820 (9 Nov: a navigator's turn calls were sent up as
 * the owner's requests).
 *
 * The microphone is Chrome's fake device, whose beeps and noise put sound in
 * most frames the page captures (47 of 57 in a run on 10 Nov). The listener is the driver's: it hears
 * "sound" in any frame that is not all zero, and it stands in for the room:
 *
 * - three frames with sound inside the app's line are the app heard, and it
 *   ends the turn with the app's words, which files them as a request;
 * - ten frames with sound after the line are the reader speaking again, and
 *   it ends the turn with the reader's question.
 *
 * The speech engine is a stand-in written into the page and the mock: CI's
 * Chromium may have no voice, so a line "plays" for `SAY_MS` by the engine's
 * own `speaking` flag. The board's speech watch wraps it as it wraps the real
 * one (`core/page-speech.ts`).
 *
 * Spawned by `lead-chat-voice-app-speech-browser.test.ts`, which reads the
 * JSON it prints.
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
/** How long a stand-in line plays. */
const SAY_MS = 2_500;
/** Frames the page captured just before the line may still be on the way. */
const GRACE_MS = 250;
const APP_LINE = 'Turn left on Riverbend Road';
const READER_LINE = { frame: 'Is Harborlight open today?', page: 'And Saltmarsh?' } as const;

export type SpeechSource = keyof typeof READER_LINE;

export interface AppSpeechCase {
  source: SpeechSource;
  /** Audio frames the listener got while the line played. */
  framesDuring: number;
  /** How many of those carried sound. */
  soundDuring: number;
  /** The app's line reached the lead as a request. */
  appFiled: boolean;
  /** Frames with sound after the line, before the reader's question ended. */
  soundAfter: number;
  /** The reader's question after the line reached the lead. */
  readerFiled: boolean;
}

export interface AppSpeechRun {
  cases: AppSpeechCase[];
}

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-voice-app-speech-driver] ${what}\n`);
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

/** A speech engine that plays each line for `SAY_MS`, installed under the
 *  board's watch, which wraps `speak` before any page script runs. Returns
 *  when the line plays, on the wall clock the driver shares. */
const STAND_IN_ENGINE = `(() => {
  const P = SpeechSynthesis.prototype;
  let until = 0;
  Object.defineProperty(P, 'speaking', { configurable: true, get: () => Date.now() < until });
  Object.defineProperty(P, 'pending', { configurable: true, get: () => false });
  const watched = P.speak;
  P.speak = function (u) {
    until = Date.now() + ${SAY_MS};
    window.__line = { start: Date.now(), end: until };
    return watched.call(this, u);
  };
  window.__sayLine = () => {
    speechSynthesis.speak(new SpeechSynthesisUtterance(${JSON.stringify(APP_LINE)}));
    return window.__line;
  };
})();`;

/** The mock: the stand-in engine, and a line said when the driver asks
 *  through the host page. Its times go back the same way. */
const MOCK = `<!doctype html><html><head><meta charset="utf-8"><title>Riverbend navigator</title></head>
<body><h1>Riverbend navigator</h1>
<script>${STAND_IN_ENGINE}
addEventListener('message', (e) => {
  if (e.data && e.data.driverSay) parent.postMessage({ driverLine: window.__sayLine() }, '*');
});
parent.postMessage({ driverReady: true }, '*');
</script></body></html>`;

/** On the host page, before its scripts: what the mock says back. */
const HOST_LISTENS = `window.addEventListener('message', (e) => {
  if (e.data && e.data.driverReady) window.__frameReady = true;
  if (e.data && e.data.driverLine) window.__frameLine = e.data.driverLine;
});`;

const BUTTON = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const b = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
})()`;

const LISTENING = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const b = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  return !!b && b.dataset.listening === 'true';
})()`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-voice-app-speech-'));
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

    /** Every audio frame the listener got: when, and whether it had sound. */
    const heard: Array<{ at: number; sound: boolean }> = [];
    const opened: TranscriptionOpenOpts[] = [];
    /** The line playing now, on the wall clock, or null. */
    let line: { start: number; end: number } | null = null;
    let appFiled = false;
    let soundAfter = 0;
    let readerLine: string | null = null;
    const listener: TranscriptionEngine = {
      name: 'driver',
      async open(opts) {
        opened.push(opts);
        let soundIn = 0;
        return {
          send: (audio) => {
            const pcm = new Int16Array(audio.buffer, audio.byteOffset, audio.byteLength >> 1);
            const sound = pcm.some((s) => s !== 0);
            const at = Date.now();
            heard.push({ at, sound });
            if (!sound) return;
            if (line && at >= line.start + GRACE_MS && at <= line.end) {
              soundIn++;
              if (soundIn === 3 && !appFiled) {
                appFiled = true;
                opts.onTurn({ turn: 0, text: APP_LINE, final: true });
              }
              return;
            }
            if (line && at > line.end && readerLine) {
              soundAfter++;
              if (soundAfter === 10) opts.onTurn({ turn: 0, text: readerLine, final: true });
            }
          },
          close: async () => {},
        };
      },
    };
    // The lead never answers aloud here; the voice only makes setup 1 usable.
    const quiet: SpokenVoice = { name: 'quiet', async speak() {} };
    handle = createServer({
      spokenReply: { listener, voices: { 1: quiet, 2: null }, gemini: null } as never,
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author: ALICE })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    handle.tasks.attachAgent(ws, { ...LEAD, runtime: 'claude-code-local' });
    handle.tasks.setLeadAgent(ws, LEAD.agentId, { actor: ALICE });
    lead = await agentStream(base, ws, LEAD.agentId);
    const stream = lead;
    const mockFile = join(dir, 'navigator.html');
    writeFileSync(mockFile, MOCK);
    const doc = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'navigator',
          type: 'mockup',
          sourceUrl: mockFile,
        })
      ).docId,
    );
    await post(`/workspaces/${ws}/docs:attach`, { docId: doc });

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) =>
        chromeLaunchArgs({ width: 1180, height: 820 }, profile, [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',

          '--mute-audio',
          '--autoplay-policy=no-user-gesture-required',
        ]),
      STARTUP_TIMEOUT_MS,
      `lead-chat-voice-app-speech-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Alice'); localStorage.setItem('cw.lead-chat.mode', 'voice'); } catch {} ${HOST_LISTENS}`,
    });

    step("the mock's page");
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${base}/workspaces/${ws}/mockups/${doc}` });
    await loaded;
    await until('the mock loaded', async () =>
      (await cdp.evaluate('!!window.__frameReady')) ? true : null,
    );
    const button = await until(
      'the agent button',
      async () => (await cdp.evaluate(BUTTON)) as { x: number; y: number } | null,
    );
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: button.x,
        y: button.y,
        button: 'left',
        clickCount: 1,
      });
    }
    await until('listening', async () => ((await cdp.evaluate(LISTENING)) ? true : null));
    await until('the mic sends sound', () =>
      heard.filter((h) => h.sound).length >= 10 ? true : null,
    );

    const cases: AppSpeechCase[] = [];
    for (const source of ['frame', 'page'] as const) {
      step(`a line spoken by the ${source}`);
      appFiled = false;
      soundAfter = 0;
      readerLine = READER_LINE[source];
      const listeners = opened.length;
      if (source === 'frame') {
        await cdp.evaluate(`window.__frameLine = null;
          document.querySelector('iframe[data-cw-mock-frame]').contentWindow.postMessage({ driverSay: true }, '*');`);
        line = await until(
          "the mock's line",
          async () =>
            (await cdp.evaluate('window.__frameLine')) as { start: number; end: number } | null,
        );
      } else {
        await cdp.evaluate(STAND_IN_ENGINE);
        line = (await cdp.evaluate('window.__sayLine()')) as { start: number; end: number };
      }
      const spoken = line;
      await until('the line to end', () => (Date.now() > spoken.end ? true : null), SAY_MS * 2);
      const filed = await until(
        "the reader's question at the lead",
        () => stream.voice.find((v) => v.transcript === readerLine) ?? null,
        8_000,
      ).catch(() => null);
      const during = heard.filter((h) => h.at >= spoken.start + GRACE_MS && h.at <= spoken.end);
      cases.push({
        source,
        framesDuring: during.length,
        soundDuring: during.filter((h) => h.sound).length,
        appFiled: appFiled || stream.voice.some((v) => v.transcript === APP_LINE),
        soundAfter,
        readerFiled: filed !== null,
      });
      line = null;
      readerLine = null;
      // The next case starts on the next question's listener.
      await until('the next listener', () => (opened.length > listeners ? true : null)).catch(() =>
        step('no new listener'),
      );
    }
    cdp.close();
    const run: AppSpeechRun = { cases };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    lead?.close();
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 170s');
  void (browser ? stopBrowser(browser.proc, browser.profile) : Promise.resolve()).finally(() =>
    process.exit(3),
  );
}, 170_000).unref();
await main();
process.exit(0);
