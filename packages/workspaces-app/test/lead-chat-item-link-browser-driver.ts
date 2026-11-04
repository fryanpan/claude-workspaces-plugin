#!/usr/bin/env bun
/**
 * A voice message to the lead, said while a review item is open on the
 * board's Home, in headless Chromium against a real server and the real
 * bundles, at 1180x820 and 430x932 (Bryan, 30 Oct: a voice message from an
 * open review item reached the lead "(at board)").
 *
 * Two orders per size: the item opened first and voice turned on over it,
 * and voice turned on first with the item opened while it listens. Each
 * time the driver says one question through a fake listener and reads the
 * `voice.request` the lead's own stream received.
 *
 * No real device and no billed engine: Chrome's fake microphone, muted
 * output, a listener the driver speaks through.
 *
 * Spawned by `lead-chat-item-link-browser.test.ts`, which reads the JSON it
 * prints.
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
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../../server/src/transcribe.ts';
import { agentStream } from '../../server/test/agent-voice-stream.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

export interface ItemLinkCase {
  width: number;
  /** Whether the item was open before voice came on, or opened while it
   *  listened. */
  order: 'item-first' | 'voice-first';
  /** The `?item=` the page's own address held when the question was said. */
  pageItem: string | null;
  /** The link the lead's `voice.request` carried, or null for none. */
  link: string | null;
  surface: string | null;
}

export interface ItemLinkRun {
  workspaceId: string;
  cases: ItemLinkCase[];
}

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-item-link-driver] ${what}\n`);
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

/** Opens the first review item on Home the way a tap on its row does. */
const OPEN_ITEM = `(() => {
  const row = document.querySelector('#board-home-review button.board-review-row');
  if (!row) return false;
  row.click();
  return true;
})()`;

const PAGE_ITEM = `new URLSearchParams(location.search).get('item')`;

/** Microphone frames the page has sent up its voice socket. */
const mic = { frames: 0 };
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
    `lead-chat-item-link-${width}-${process.pid}`,
    (started) => {
      browsers.push(started);
    },
  );
  const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const voiceSockets = new Set<string>();
  cdp.on('Network.webSocketCreated', (p) => {
    const e = p as unknown as { requestId: string; url: string };
    if (e.url.includes('/voice/converse')) voiceSockets.add(e.requestId);
  });
  cdp.on('Network.webSocketFrameSent', (p) => {
    const e = p as unknown as { requestId: string; response: { opcode: number } };
    if (voiceSockets.has(e.requestId) && e.response.opcode === 2) mic.frames++;
  });
  await cdp.send('Network.enable');
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
  return cdp;
}

async function tap(cdp: Cdp, at: { x: number; y: number }): Promise<void> {
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

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-item-link-'));
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
    const post = async (path: string, payload: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author: ALICE })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    server.tasks.attachAgent(ws, { ...LEAD, runtime: 'claude-code-local' });
    server.tasks.setLeadAgent(ws, LEAD.agentId, { actor: ALICE });
    lead = await agentStream(base, ws, LEAD.agentId);
    const author = { id: LEAD.agentId, name: LEAD.agentName, kind: 'agent' };
    const { task } = (await post(`/workspaces/${ws}/tasks`, {
      title: 'Harborlight tide table',
      body: 'Alice can read the tides so that sailors plan.',
      author,
    })) as { task: { id: string } };
    await post(`/workspaces/${ws}/tasks/${task.id}/review-items`, {
      review: {
        shape: 'decision',
        headline: 'Which tide table goes on the Harborlight front page?',
        detail: 'The gauge is closer; the buoy is steadier.',
        options: [
          { id: 'gauge', label: 'Gauge' },
          { id: 'buoy', label: 'Buoy' },
        ],
      },
      author,
    });

    const homeUrl = `${base}/workspaces/${ws}/home`;
    const cases: ItemLinkCase[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      const cdp = await openBrowser(width, height);
      for (const order of ['item-first', 'voice-first'] as const) {
        step(`${order} at ${width}`);
        for (let i = 0; i < 2; i++) {
          if (i === 1) await cdp.evaluate('sessionStorage.clear()');
          const loaded = cdp.once('Page.loadEventFired');
          await cdp.send('Page.navigate', { url: homeUrl });
          await loaded;
        }
        const openItem = async (): Promise<void> => {
          await until('a review row on Home', async () =>
            (await cdp.evaluate(OPEN_ITEM)) === true ? true : null,
          );
          await until('the item in the address', async () =>
            (await cdp.evaluate(PAGE_ITEM)) ? true : null,
          );
        };
        if (order === 'item-first') await openItem();
        const btn = await until(
          'the agent button',
          async () => (await cdp.evaluate(BUTTON)) as { x: number; y: number } | null,
        );
        const before = opened.length;
        await tap(cdp, btn);
        await until('listening', async () => ((await cdp.evaluate(LISTENING)) ? true : null));
        await until('the listener opened', () => (opened.length > before ? true : null));
        if (order === 'voice-first') await openItem();
        // The mic keeps streaming; let a few frames go up after the move.
        const from = mic.frames;
        await until('mic frames after the item opened', () =>
          mic.frames - from >= 3 ? true : null,
        );
        const pageItem = (await cdp.evaluate(PAGE_ITEM)) as string | null;
        const said = `Gauge, for the ${order} case at ${width}`;
        opened.at(-1)?.onTurn({ turn: 0, text: said, final: true });
        const frame = await until('the lead heard it', () =>
          lead ? (lead.voice.find((v) => v.transcript === said) ?? null) : null,
        );
        cases.push({
          width,
          order,
          pageItem,
          link: frame.context?.link ?? null,
          surface: frame.context?.surface ?? null,
        });
      }
      cdp.close();
    }
    const run: ItemLinkRun = { workspaceId: ws, cases };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    lead?.close();
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 200s');
  void Promise.all(browsers.map((b) => stopBrowser(b.proc, b.profile))).finally(() =>
    process.exit(3),
  );
}, 200_000).unref();
await main();
process.exit(0);
