#!/usr/bin/env bun
/**
 * A voice-led mock that listens through the reader's microphone, on its
 * board page, in headless Chromium against real board servers with a
 * scripted listener.
 *
 * The mock loads `/widget/app-voice.js`, connects on load, and on a tap of
 * its Talk button calls `listen()`, which opens the microphone in the mock's
 * own frame and streams it to the app voice socket through the board's page
 * holding it (`mock-bridge.ts` → `mock-host.ts`). The scripted listener ends
 * a turn once it has been sent a few frames, so a `turn-end` in the mock
 * means the microphone's audio reached the server and the answer came back.
 *
 * Chrome runs with its fake microphone and fake permission prompt, so a
 * refusal is the browser's verdict on where the call was made, never a person
 * saying no. Nothing is played: the browser is muted and the mock connects
 * with `play: false`.
 *
 * Three readings:
 *
 * - `opaque`: a board with no frame hostname. The frame has an opaque origin.
 *   Its `connect()` is the CONTROL that the socket, the token and the relay
 *   work there, so a refused `listen()` is the microphone and nothing else.
 * - `frameHost`: a board with the frame-only hostname configured
 *   (`frame-host.ts`), whose frame has an origin of its own that is not the
 *   board's.
 * - `ownTab`: the opaque board's frame address opened at the top, which is
 *   what "open the mock in its own tab" does on the board.
 *
 * Spawned by `app-voice-mic.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns came from a running page or server.
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
import {
  type Surface,
  frameSessions,
  frameSurface,
  navigate,
  pageSurface,
  poll,
  step,
  tapUntil,
} from './draft-reload-page.ts';
import { buildWidget } from './frame-driver-kit.ts';

/** What the scripted listener says once it has heard this many frames. */
export const HEARD = 'Riverbend first, then Saltmarsh.';
const TURN_AFTER = 3;

/** What one framed mock saw. */
export interface MicMock {
  /** `self.origin`: the string `null` for an opaque origin. */
  origin: string;
  /** `connect()` resolved: the token, the socket and the relay work here. */
  connected: boolean;
  /** `ok`, or `refused:<error name>: <message>` from `listen()`. */
  listen: string | null;
  /** The turn the server ended from this page's microphone audio. */
  turnEnd: string | null;
  error: string | null;
}

export interface MicArm {
  mock: MicMock | null;
  /** Audio frames the server's listener was sent from the page. */
  heardFrames: number;
}

export interface AppVoiceMicReading {
  opaque: MicArm;
  frameHost: MicArm;
  /** The opaque board's frame address opened at the top. */
  ownTab: { landed: string; mock: MicMock | null } | null;
}

const MOCK = `<!doctype html><html><head><meta charset="utf-8">
<title>Harborlight voice</title><script src="/widget/app-voice.js"></script></head>
<body><h1 id="title">Riverbend</h1><button id="talk" style="font-size:24px">Talk</button>
<script>
window.__av = null;
const seen = { origin: self.origin, connected: false, listen: null, turnEnd: null, error: null };
const report = () => { window.__av = { ...seen }; };
cwAppVoice.connect({ play: false }).then((v) => {
  seen.connected = true;
  v.on('turn-end', (text) => { seen.turnEnd = text; report(); });
  document.getElementById('talk').addEventListener('click', () => {
    window.__tapped = true;
    v.listen().then(
      () => { seen.listen = 'ok'; report(); },
      (e) => { seen.listen = 'refused:' + (e && e.name) + ': ' + (e && e.message); report(); },
    );
  });
  report();
}, (e) => { seen.error = String(e && e.message); report(); });
</script></body></html>`;

/** The mock has answered the tap: its listen settled, and a turn ended if it could. */
const SETTLED = `(() => { const a = window.__av; return a && (a.error || (a.listen && (a.listen !== 'ok' || a.turnEnd))) ? a : null; })()`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'app-voice-mic-'));
  const servers: ServerHandle[] = [];
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

    /** A board with the mock attached; `frames` turns the frame hostname on. */
    const board = async (name: string, frames: boolean) => {
      const heard = { frames: 0 };
      const voice: SpokenVoice = { name: 'scripted', async speak() {} };
      const listener: TranscriptionEngine = {
        name: 'scripted',
        async open(opts) {
          return {
            send: () => {
              heard.frames++;
              if (heard.frames === TURN_AFTER) opts.onTurn({ turn: 0, text: HEARD, final: true });
            },
            close: async () => {},
          };
        },
      };
      // The frame origin names the port, so learn a free one first and reuse it.
      const probe = createServer({ port: 0, dataDir: join(dir, `${name}-probe`) });
      const port = probe.port;
      await probe.stop();
      const h = createServer({
        port,
        dataDir: join(dir, name),
        widgetDistDir: dist,
        requireSignInToWrite: false,
        spokenReply: { listener, voices: { 1: voice, 2: null }, gemini: null } as never,
        ...(frames
          ? {
              frameOrigin: `http://harborlight.frames.localhost:${port}`,
              frameBoardHosts: ['127.0.0.1'],
            }
          : {}),
      });
      servers.push(h);
      const base = `http://127.0.0.1:${port}`;
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
      return { page: `${base}/workspaces/${ws}/mockups/${doc}`, heard };
    };
    const opaqueBoard = await board('opaque', false);
    const framesBoard = await board('frames', true);

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) =>
        chromeLaunchArgs({ width: 1180, height: 820 }, profile, [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--mute-audio',
        ]),
      STARTUP_TIMEOUT_MS,
      `app-voice-mic-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const sessions = await frameSessions(cdp);
    const frame = frameSurface(cdp, sessions);
    const top = pageSurface(cdp);

    /** Open the board's page, wait for the mock to connect, tap Talk. */
    const talk = async (
      s: Surface,
      page: string,
      heard: { frames: number },
      what: string,
    ): Promise<MicArm> => {
      await navigate(cdp, page);
      const first = await poll(
        `${what}: the mock connected`,
        async () => (await s.eval('window.__av')) as MicMock | null,
      ).catch(() => null);
      if (!first?.connected) return { mock: first, heardFrames: heard.frames };
      // The first tap after a frame loads can reach nothing (`tapUntil`).
      await tapUntil(cdp, s, `document.getElementById('talk')`, 'window.__tapped', `${what}: Talk`);
      const mock = await poll(
        `${what}: the mock settled`,
        async () => (await s.eval(SETTLED)) as MicMock | null,
      ).catch(async () => (await s.eval('window.__av')) as MicMock | null);
      return { mock, heardFrames: heard.frames };
    };

    step('opaque: the board with no frame hostname');
    const opaque = await talk(frame, opaqueBoard.page, opaqueBoard.heard, 'opaque');

    step('frameHost: the board with the frame-only hostname');
    const frameHost = await talk(frame, framesBoard.page, framesBoard.heard, 'frameHost');

    step("ownTab: the opaque board's frame address opened at the top");
    await navigate(cdp, `${opaqueBoard.page}?cw-frame=1`);
    const ownTab = await poll(
      'the own tab settled',
      async () =>
        (await top.eval(
          `(() => { const back = !location.search.includes('cw-frame'); const a = window.__av; return back || a ? { landed: location.pathname + location.search, mock: a || null } : null; })()`,
        )) as AppVoiceMicReading['ownTab'],
    ).catch(() => null);

    const reading: AppVoiceMicReading = { opaque, frameHost, ownTab };
    cdp.close();
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    for (const h of servers) await h.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
