#!/usr/bin/env bun
/**
 * The lead's written answer to a spoken question, in the board's chat, in
 * headless Chromium against a real server and the real bundles, at 1180x820
 * and 430x932.
 *
 * The reader talks to the lead by voice on Home. The lead answers with
 * `answer_voice`'s short `text`, said aloud, and a `written` part holding a
 * link to a doc, which the chat shows and nothing says. Three ways the chat
 * can be when the answer comes:
 *
 * - `open`: the panel is open. The written part must show within 1s.
 * - `closed`: voice is on in the bar and the panel is shut. It must be there
 *   when the reader opens the panel.
 * - `left`: the reader moved to another page before the answer came, so the
 *   asking socket is gone. It must be there when they open the chat.
 *
 * Each time the driver then taps the link and records where the tap went.
 * No real device and no billed engine: Chrome's fake microphone, muted
 * output, a listener the driver speaks through.
 *
 * Spawned by `lead-chat-written-browser.test.ts`, which reads the JSON it
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
/** How long the written answer may take to show once the chat can show it. */
const SHOW_MS = 1000;

export type WrittenWay = 'open' | 'closed' | 'left';

export interface WrittenCase {
  width: number;
  way: WrittenWay;
  /** `answer_voice` said a page was waiting for the answer. */
  delivered: boolean;
  /** The written answer's link was drawn, visible, within `SHOW_MS` of the
   *  chat being open with the answer sent. */
  shown: boolean;
  /** The path its href names, as drawn. */
  href: string | null;
  /** Where the tap on it went: the board tab's URL, or a new tab's. */
  landed: string;
}

export interface WrittenRun {
  docPath: string;
  cases: WrittenCase[];
}

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-written-driver] ${what}\n`);
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

const STATE = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const b = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const shown = (el) => !!el && !el.hidden && el.getBoundingClientRect().width > 0;
  const pane = sr && sr.querySelector('.lc-pane');
  const settled = !pane || pane.getAnimations().length === 0;
  return {
    listening: !!b && b.dataset.listening === 'true',
    barOut: shown(sr && sr.querySelector('.lc-bar')),
    paneOpen: shown(pane) && settled,
  };
})()`;

const BAR = `(() => {
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const el = sr && sr.querySelector('.lc-bar');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 ? { x: r.left + Math.min(r.width / 2, 12), y: r.top + r.height / 2 } : null;
})()`;

/** This case's written answer's link, where it is on screen, or null while
 *  it is not drawn where a finger can reach it. Every case links the same
 *  doc, so the link is looked for only in the message that says `words`:
 *  an earlier case's answer would satisfy a bare href match before this
 *  one arrived, and the chat then scrolls to the new answer under the tap. */
const LINK = (href: string, words: string): string => `(() => {
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const pane = sr && sr.querySelector('.lc-pane');
  if (!pane || pane.hidden || pane.getAnimations().length > 0) return null;
  const msg = [...sr.querySelectorAll('.lc-list .lc-msg')].find((m) => m.textContent.includes(${JSON.stringify(words)}));
  const a = msg && [...msg.querySelectorAll('a')].find((x) => new URL(x.href).pathname === ${JSON.stringify(href)});
  if (!a) return null;
  a.scrollIntoView({ block: 'center' });
  const r = a.getBoundingClientRect();
  if (r.width === 0) return null;
  const x = r.left + Math.min(r.width / 2, 12);
  const y = r.top + r.height / 2;
  const top = sr.elementFromPoint(x, y);
  if (!top || (top !== a && !a.contains(top))) return null;
  return { x, y, href: new URL(a.href).pathname };
})()`;

type XY = { x: number; y: number };
const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function openBrowser(width: number, height: number): Promise<{ cdp: Cdp; port: number }> {
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
    `lead-chat-written-${width}-${process.pid}`,
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
  // `CW_CPU_THROTTLE=4` runs it on a slower CPU, as a loaded CI runner is.
  const throttle = Number(process.env.CW_CPU_THROTTLE ?? '');
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  // A returning reader on a Voice first device: the first tap listens.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); localStorage.setItem('cw.lead-chat.mode', 'voice'); } catch {}`,
  });
  return { cdp, port: b.port };
}

async function tabs(port: number): Promise<Array<{ id: string; url: string }>> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = (await res.json()) as Array<{ id: string; type: string; url: string }>;
  return list.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url }));
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

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-written-'));
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
    const made = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harborlight', author: ALICE }),
    });
    if (!made.ok) throw new Error(`/workspaces: ${made.status} ${await made.text()}`);
    const ws = ((await made.json()) as { workspace: { id: string } }).workspace.id;
    server.tasks.attachAgent(ws, { ...LEAD, runtime: 'claude-code-local' });
    server.tasks.setLeadAgent(ws, LEAD.agentId, { actor: ALICE });
    lead = await agentStream(base, ws, LEAD.agentId);
    const stream = lead;
    const docPath = `/workspaces/${ws}/docs/d-riverbend`;
    const homeUrl = `${base}/workspaces/${ws}/home`;

    const cases: WrittenCase[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      const { cdp, port } = await openBrowser(width, height);
      const load = async (): Promise<void> => {
        const loaded = cdp.once('Page.loadEventFired');
        await cdp.send('Page.navigate', { url: homeUrl });
        await loaded;
      };
      const state = async () =>
        (await cdp.evaluate(STATE)) as { listening: boolean; barOut: boolean; paneOpen: boolean };
      const button = () =>
        until('the agent button', async () => (await cdp.evaluate(BUTTON)) as XY | null);
      /** Voice on from the agent button: the bar comes out, listening. */
      const voiceOn = async (): Promise<void> => {
        const before = opened.length;
        await tap(cdp, await button());
        await until('listening', async () => ((await state()).listening ? true : null));
        await until('the listener opened', () => (opened.length > before ? true : null));
      };
      const openPanel = async (): Promise<void> => {
        const bar = await until('the bar', async () => (await cdp.evaluate(BAR)) as XY | null);
        await tap(cdp, bar);
        await until('the panel open', async () => ((await state()).paneOpen ? true : null));
      };

      for (const way of ['open', 'closed', 'left'] as const) {
        step(`${way} at ${width}`);
        for (let i = 0; i < 2; i++) {
          if (i === 1) await cdp.evaluate('sessionStorage.clear()');
          await load();
        }
        await voiceOn();
        if (way === 'open') await openPanel();
        const said = `Where is the summary, ${way} at ${width}?`;
        opened.at(-1)?.onTurn({ turn: 0, text: said, final: true });
        const frame = await until(
          'the lead heard it',
          () => stream.voice.find((v) => v.transcript === said) ?? null,
        );
        // Away from the page that asked: its socket goes with it.
        if (way === 'left') await load();
        const heading = `The summary for the ${way} case at ${width}:`;
        const written = [
          heading,
          '',
          `- [The Riverbend summary](${docPath})`,
          `- [The same, absolute](${base}${docPath})`,
        ].join('\n');
        const answered = await fetch(
          `${base}/workspaces/${ws}/voice-queue/${frame.queueId}/answer`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ agentId: LEAD.agentId, text: 'It is in the chat.', written }),
          },
        );
        if (!answered.ok) throw new Error(`answer: ${answered.status} ${await answered.text()}`);
        const { delivered } = (await answered.json()) as { delivered: boolean };
        if (way === 'closed') await openPanel();
        if (way === 'left') {
          // Voice may have come back on by itself on the new page, the bar
          // out; if not, the agent button brings it.
          const back = await until(
            'voice back on by itself',
            async () => ((await state()).barOut ? true : null),
            6000,
          ).catch(() => false);
          if (!back) await tap(cdp, await button());
          await until('the bar', async () => ((await state()).barOut ? true : null));
          await openPanel();
        }
        const link = await until(
          'the written link',
          async () =>
            (await cdp.evaluate(LINK(docPath, heading))) as (XY & { href: string }) | null,
          SHOW_MS,
        ).catch(() => null);
        let landed = String(await cdp.evaluate('location.href'));
        if (link) {
          const before = new Set((await tabs(port)).map((t) => t.id));
          await tap(cdp, link);
          landed = await until(
            'the tap to go somewhere',
            async () => {
              const fresh = (await tabs(port)).filter(
                (t) => !before.has(t.id) && t.url !== 'about:blank',
              );
              if (fresh[0]) return fresh[0].url;
              const here = String(await cdp.evaluate('location.href').catch(() => ''));
              return here.includes('/docs/') ? here : null;
            },
            4000,
          ).catch(() => landed);
          // A new tab takes the focus, and a page behind it runs no
          // animation: close it and bring the board back.
          for (const t of await tabs(port)) {
            if (!before.has(t.id)) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
          }
          await cdp.send('Page.bringToFront');
        }
        cases.push({
          width,
          way,
          delivered,
          shown: link !== null,
          href: link?.href ?? null,
          landed,
        });
      }
      cdp.close();
    }
    const run: WrittenRun = { docPath, cases };
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
