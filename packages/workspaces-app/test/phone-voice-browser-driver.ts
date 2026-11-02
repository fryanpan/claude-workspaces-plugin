#!/usr/bin/env bun
/**
 * Voice to the lead from a phone, in headless Chromium at 430x932 with touch
 * input, against a real server and the real bundles: a finger tap on the
 * agent button opens the chat listening, and the microphone's audio reaches
 * the server's listener.
 *
 * Chromium starts an AudioContext from any page that has had a tap. iOS
 * Safari does not: a context runs only once `resume()` is called inside the
 * gesture itself. So before the page's scripts run, this driver installs a
 * model of that rule (`SAFARI_AUDIO_RULE`): a new context is held suspended,
 * and `resume()` takes effect only while a tap's own event is being handled.
 * It is a model of Safari's behaviour, not Safari; what it reproduces is the
 * ordering, which is the thing a phone gets wrong.
 *
 * No real device and no billed engine: Chrome's fake microphone, muted
 * output, and a scripted listener that counts the frames it is sent.
 * Spawned by `phone-voice-browser.test.ts`, which reads the JSON it prints.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

export interface PhoneVoiceRun {
  /** Audio frames the server's listener was sent after the tap. */
  framesHeard: number;
  /** Contexts the page made, and how many a tap's own handler resumed. */
  audio: { made: number; resumedInTap: number; refused: number };
  listening: boolean;
  /** What the chat said, when it said why voice stopped. */
  status: string;
}

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const step = (what: string): void => void process.stderr.write(`[phone-voice] ${what}\n`);

/** Safari's audio-start rule, modelled: see the header. */
const SAFARI_AUDIO_RULE = `(() => {
  let tap = false;
  for (const t of ['touchend', 'click', 'pointerup', 'mouseup', 'keydown'])
    addEventListener(t, () => { tap = true; setTimeout(() => { tap = false; }, 0); }, true);
  const Native = window.AudioContext;
  const log = (window.__safariAudio = { made: 0, resumedInTap: 0, refused: 0 });
  class SafariRule extends Native {
    constructor(...a) {
      super(...a);
      log.made++;
      this.__allowed = false;
      Native.prototype.suspend.call(this);
    }
    resume() {
      if (tap && !this.__allowed) { this.__allowed = true; log.resumedInTap++; }
      if (!this.__allowed) {
        log.refused++;
        return Promise.reject(new DOMException('needs a gesture', 'NotAllowedError'));
      }
      return Native.prototype.resume.call(this);
    }
  }
  window.AudioContext = SafariRule;
  window.webkitAudioContext = SafariRule;
})();`;

const READ = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const r = btn && btn.getBoundingClientRect();
  return {
    button: r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null,
    listening: btn ? btn.dataset.listening === 'true' : false,
    status: [sr?.querySelector('.lc-status')?.textContent, sr?.querySelector('.lc-bar')?.textContent]
      .filter(Boolean).join(' ').trim(),
    audio: window.__safariAudio || null,
  };
})()`;

interface Read {
  button: { x: number; y: number } | null;
  listening: boolean;
  status: string;
  audio: PhoneVoiceRun['audio'] | null;
}

async function until<T>(what: string, read: () => Promise<T | null>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null) return v;
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'phone-voice-'));
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
    const ears = { frames: 0 };
    const listener: TranscriptionEngine = {
      name: 'scripted',
      async open() {
        return { send: () => void ears.frames++, close: async () => {} };
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

    step('open a phone-sized page');
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) =>
        chromeLaunchArgs({ width: 430, height: 932 }, profile, [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--mute-audio',
        ]),
      STARTUP_TIMEOUT_MS,
      `phone-voice-${process.pid}`,
      (started) => void browsers.push(started),
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 430,
      height: 932,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}\n${SAFARI_AUDIO_RULE}`,
    });
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${base}/workspaces/${ws}` });
    await loaded;
    const before = await until(
      'the agent button',
      async () => {
        const r = (await cdp.evaluate(READ)) as Read;
        return r.button ? r : null;
      },
      20_000,
    );
    const at = before.button as { x: number; y: number };
    step('tap the agent button with a finger');
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: at.x, y: at.y }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // Frames arrive within a few hundred ms once the context runs; the bound
    // is the chat's own no-sound notice, which ends the wait either way.
    const end = Date.now() + 8_000;
    let last = (await cdp.evaluate(READ)) as Read;
    while (Date.now() < end && ears.frames === 0) {
      await sleep(100);
      last = (await cdp.evaluate(READ)) as Read;
    }
    const run: PhoneVoiceRun = {
      framesHeard: ears.frames,
      audio: last.audio ?? { made: 0, resumedInTap: 0, refused: 0 },
      listening: last.listening,
      status: last.status,
    };
    cdp.close();
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
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
