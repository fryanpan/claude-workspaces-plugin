#!/usr/bin/env bun
/**
 * A mock's own `getUserMedia`, called in headless Chromium against a real
 * board server, in three places:
 *
 * - `framed`: the board's page for the mock, which holds the sandboxed frame.
 *   This is also what a new tab on the mock shows: the frame's own address
 *   opened at the top sends itself back to that page (`mock-bridge.ts`).
 * - `frameHost`: the board's page for the mock on a server with the
 *   frame-only hostname (`frame-host.ts`), whose frame has an origin of its own.
 * - `control`: the same HTML served unsandboxed by a plain server on loopback.
 *
 * Chrome runs with its fake microphone and fake permission prompt, so a
 * refusal is the browser's verdict on where the call was made, never a person
 * saying no. The mock asks once on load and records what came back.
 *
 * Spawned by `mock-mic.test.ts`, which reads the JSON it prints.
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
import {
  type Surface,
  frameSessions,
  frameSurface,
  navigate,
  pageSurface,
  poll,
  step,
} from './draft-reload-page.ts';
import { buildWidget } from './frame-driver-kit.ts';

/** What one page's call came back with. */
export interface MicSight {
  /** `self.origin`: the string `null` for an opaque origin. */
  origin: string;
  secure: boolean;
  /** `ok:<live audio tracks>`, or `refused:<error name>: <message>`. */
  result: string;
}

export interface MicReading {
  framed: MicSight | null;
  frameHost: MicSight | null;
  control: MicSight | null;
}

const MOCK = `<!doctype html><html><head><meta charset="utf-8">
<title>Harborlight voice</title></head><body><h1 id="title">Riverbend voice</h1>
<script>
window.__mic = null;
(async () => {
  let result;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    const live = s.getAudioTracks().filter((t) => t.readyState === 'live').length;
    s.getTracks().forEach((t) => t.stop());
    result = 'ok:' + live;
  } catch (e) {
    result = 'refused:' + (e && e.name) + ': ' + (e && e.message);
  }
  window.__mic = { origin: self.origin, secure: isSecureContext, result };
})();
</script></body></html>`;

const SIGHT = 'window.__mic';

async function sightOn(s: Surface, what: string): Promise<MicSight | null> {
  return poll(what, async () => (await s.eval(SIGHT)) as MicSight | null).catch(() => null);
}

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mock-mic-'));
  const servers: ServerHandle[] = [];
  let plain: ReturnType<typeof Bun.serve> | undefined;
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    const mockFile = join(dir, 'voice.html');
    writeFileSync(mockFile, MOCK);

    /** A board with the mock attached; `frames` turns the frame hostname on. */
    const board = async (name: string, frames: boolean) => {
      const probe = createServer({ port: 0, dataDir: join(dir, `${name}-probe`) });
      const port = probe.port;
      await probe.stop();
      const h = createServer({
        port,
        dataDir: join(dir, name),
        widgetDistDir: dist,
        requireSignInToWrite: false,
        ...(frames
          ? { frameOrigin: `http://frames.localhost:${port}`, frameBoardHosts: ['127.0.0.1'] }
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
      const agent = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
      const ws = String(
        (
          (await post('/workspaces', { name: 'Harborlight', author: agent })) as {
            workspace: { id: string };
          }
        ).workspace.id,
      );
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
      return `${base}/workspaces/${ws}/mockups/${doc}`;
    };
    const page = await board('opaque', false);
    const framesPage = await board('frames', true);

    plain = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(MOCK, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) =>
        chromeLaunchArgs({ width: 1180, height: 820 }, profile, [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
        ]),
      STARTUP_TIMEOUT_MS,
      `mock-mic-${process.pid}`,
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

    step('control: the mock unsandboxed, in its own tab');
    await navigate(cdp, `http://127.0.0.1:${plain.port}/`);
    const control = await sightOn(top, 'the control page answered');

    step("framed: the board's page for the mock");
    await navigate(cdp, page);
    const framed = await sightOn(frame, 'the frame answered');

    step('frameHost: framed on the frame-only hostname');
    await navigate(cdp, framesPage);
    const frameHost = await sightOn(frame, 'the frame-host frame answered');

    const reading: MicReading = { framed, frameHost, control };
    cdp.close();
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    plain?.stop(true);
    for (const h of servers) await h.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
