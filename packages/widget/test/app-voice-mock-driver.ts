#!/usr/bin/env bun
/**
 * A served mock that talks, in headless Chromium against a real board server
 * with a scripted voice and listener.
 *
 * The mock loads `/widget/app-voice.js` and nothing else of the board's. The
 * server writes the socket's path and a token into its frame. The frame has
 * an opaque origin, so its socket goes through the board's page holding it
 * (`mock-bridge.ts` → `mock-host.ts`). The mock speaks a line with a tone,
 * then sends two frames of silence as its own audio and waits for the turn
 * to end. It connects with `play: false`, so nothing is played: the mock
 * counts the speech it was sent instead.
 *
 * Spawned by `app-voice-mock.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns came from a running page.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, launchChrome, pageSocketUrl, stopBrowser } from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import type { SpokenVoice } from '../../server/src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../../server/src/transcribe.ts';
import { frameSessions, frameSurface, navigate, poll, step } from './draft-reload-page.ts';
import { buildWidget } from './frame-driver-kit.ts';

/** What the mock saw, and what the server's engines were asked. */
export interface AppVoiceMockReading {
  mock: {
    origin: string;
    abilities: { voice: string | null; listen: boolean; say: boolean };
    spoken: { stopped: boolean };
    audioBytes: number;
    turnEnd: string;
    error: string | null;
  } | null;
  /** The lines the scripted voice was asked to say. */
  spoken: string[];
  /** Audio frames the scripted listener was sent. */
  heardFrames: number;
}

const MOCK = `<!doctype html><html><head><meta charset="utf-8">
<title>Riverbend voice</title><script src="/widget/app-voice.js"></script></head>
<body><h1 id="title">Riverbend</h1>
<script>
window.__av = null;
(async () => {
  try {
    const v = await cwAppVoice.connect({ play: false });
    let audioBytes = 0;
    v.on('audio', (pcm) => { audioBytes += pcm.byteLength; });
    const spoken = await v.speak('Welcome to Riverbend.', { tone: 'warm' });
    const turnEnd = new Promise((r) => v.on('turn-end', r));
    await v.listen({ mic: false });
    v.sendAudio(new Int16Array(800));
    v.sendAudio(new Int16Array(800));
    window.__av = {
      origin: self.origin,
      abilities: v.abilities,
      spoken,
      audioBytes,
      turnEnd: await turnEnd,
      error: null,
    };
  } catch (e) {
    window.__av = { origin: self.origin, error: String(e && e.message) };
  }
})();
</script></body></html>`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'app-voice-mock-'));
  let handle: ServerHandle | undefined;
  const spoken: string[] = [];
  let heardFrames = 0;
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    const built = await Bun.build({
      entrypoints: [join(import.meta.dirname, '../src/app-voice/app-voice-entry.ts')],
      outdir: dist,
      target: 'browser',
      format: 'iife',
      naming: 'app-voice.js',
    });
    if (!built.success) throw new Error(`app-voice build failed: ${built.logs.join('\n')}`);
    const mockFile = join(dir, 'voice.html');
    writeFileSync(mockFile, MOCK);

    const voice: SpokenVoice = {
      name: 'scripted',
      async speak(text, onAudio) {
        spoken.push(text);
        onAudio(new Uint8Array(480));
        onAudio(new Uint8Array(480));
      },
    };
    const listener: TranscriptionEngine = {
      name: 'scripted',
      async open(opts) {
        return {
          send: () => {
            heardFrames++;
            if (heardFrames === 2) opts.onTurn({ turn: 0, text: 'I think so.', final: true });
          },
          close: async () => {},
        };
      },
    };
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      requireSignInToWrite: false,
      spokenReply: { listener, voices: { 1: voice, 2: null }, gemini: null } as never,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const agent = { id: 'agent-harborlight', name: 'Harborlight Agent', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author: agent })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const doc = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'voice',
          type: 'mockup',
          sourceUrl: mockFile,
        })
      ).docId,
    );
    await post(`/workspaces/${ws}/docs:attach`, { docId: doc });

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile, ['--mute-audio']),
      STARTUP_TIMEOUT_MS,
      `app-voice-mock-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const sessions = await frameSessions(cdp);
    const frame = frameSurface(cdp, sessions);

    step("the board's page for the mock");
    await navigate(cdp, `${base}/workspaces/${ws}/mockups/${doc}`);
    const mock = await poll(
      'the mock talked',
      async () => (await frame.eval('window.__av')) as AppVoiceMockReading['mock'],
    ).catch(() => null);

    const reading: AppVoiceMockReading = { mock, spoken, heardFrames };
    cdp.close();
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
