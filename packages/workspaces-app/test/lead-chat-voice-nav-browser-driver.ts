#!/usr/bin/env bun
/**
 * Voice chat with the lead, carried across a board link, in headless
 * Chromium against a real server and the real bundles, at 1180x820 and
 * 430x932 (Bryan, 3 Nov: "When I click on a link in workspace while agent is
 * active in voice mode, it switched into meeting mode and turned off the
 * agent").
 *
 * For each size and each way of having voice on — the bar alone (Voice
 * first's first tap) and the panel open — it starts listening on the board's
 * Home, follows a link in the lead's reply to a doc (a full page load), and
 * reads what the new page shows: whether the bar or the panel is out, whether
 * the agent button is listening, whether the microphone streams again,
 * whether anything of a meeting is drawn, and whether a tap was needed.
 *
 * No real device and no billed engine: Chrome's fake microphone, muted
 * output, a listener that only counts the frames it is sent.
 *
 * Spawned by `lead-chat-voice-nav-browser.test.ts`, which reads the JSON it
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
import { LeadChatLog } from '../../server/src/lead-chat/log.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import type { SpokenVoice } from '../../server/src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../../server/src/transcribe.ts';
import { agentStream } from '../../server/test/agent-voice-stream.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

/** What the new page shows of the chat. */
export interface VoiceNavRead {
  /** The agent button is drawn. */
  button: boolean;
  listening: boolean;
  barOut: boolean;
  paneOpen: boolean;
  /** Anything of a meeting: its heading, the wizard that starts one, the
   *  red dot on the agent button. The selectors are the ones
   *  `lead-chat-meeting-browser.test.ts` sees drawn in a meeting. */
  meetingShown: boolean;
  /** The panel's status line: what it hears, or why voice is off. */
  status: string;
}

export interface VoiceNavCase {
  width: number;
  /** How voice was on when the link was followed. */
  how: 'bar' | 'panel';
  /** The link followed: one to a doc, or the side nav's Tasks. */
  link: 'doc' | 'nav';
  before: VoiceNavRead;
  after: VoiceNavRead;
  /** The page the link landed on. */
  landed: string;
  /** Following the link loaded a new document, rather than routing in place. */
  fullLoad: boolean;
  /** Microphone frames the new page sent up its voice socket, with no tap
   *  on that page. */
  framesAfter: number;
}

export interface VoiceNavRun {
  docPath: string;
  cases: VoiceNavCase[];
}

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-voice-nav-driver] ${what}\n`);
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
  const shown = (el) => !!el && !el.hidden && el.getBoundingClientRect().width > 0;
  const pane = sr && sr.querySelector('.lc-pane');
  const bar = sr && sr.querySelector('.lc-bar');
  const meet = sr && [...sr.querySelectorAll('.lc-meet, .lc-wiz')].some(shown);
  return {
    button: shown(btn),
    listening: btn ? btn.dataset.listening === 'true' : false,
    barOut: shown(bar),
    paneOpen: shown(pane),
    status: sr && sr.querySelector('.lc-status') ? sr.querySelector('.lc-status').textContent : '',
    meetingShown: !!meet || (btn ? btn.dataset.meeting === 'true' : false),
  };
})()`;

const BUTTON = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const b = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
})()`;

const centreOf = (sel: string): string => `(() => {
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const el = sr && sr.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return r.width > 0 ? { x: r.left + Math.min(r.width / 2, 12), y: r.top + r.height / 2 } : null;
})()`;

/** Puts a link to the doc on the page, where a finger can reach it, and
 *  answers its centre. */
const PLANT_DOC_LINK = (path: string): string => `(() => {
  let a = document.getElementById('riverbend-link');
  if (!a) {
    a = document.createElement('a');
    a.id = 'riverbend-link';
    a.href = ${JSON.stringify(path)};
    a.textContent = 'Riverbend summary';
    a.style.cssText = 'position:fixed;left:50%;top:40%;z-index:1;padding:8px;background:#fff';
    document.body.append(a);
  }
  const r = a.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

/** The side nav's Tasks item, or null where it is not on screen. */
const NAV_TASKS = `(() => {
  const el = [...document.querySelectorAll('.board-nav-item')].find((n) => /Tasks/.test(n.textContent || '') && n.getBoundingClientRect().width > 0);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

/** Microphone frames sent by the page under test, across its loads. */
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
    `lead-chat-voice-nav-${width}-${process.pid}`,
    (started) => {
      browsers.push(started);
    },
  );
  const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // The microphone's frames are the binary ones up the voice socket.
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
  // A returning reader on a Voice first device.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); localStorage.setItem('cw.lead-chat.mode', 'voice'); } catch {}`,
  });
  return cdp;
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

const read = async (cdp: Cdp): Promise<VoiceNavRead> => (await cdp.evaluate(READ)) as VoiceNavRead;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-voice-nav-'));
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
        return {
          send: () => {},
          close: async () => {},
        };
      },
    };
    const quiet: SpokenVoice = {
      name: 'quiet',
      speak: async (_t, onAudio) => onAudio(new Uint8Array(480)),
    };
    const dataDir = join(dir, 'data');
    handle = createServer({
      spokenReply: { listener, voices: { 1: quiet, 2: null }, gemini: null } as never,
      port: 0,
      dataDir,
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

    const plan = join(dir, 'riverbend-summary.md');
    writeFileSync(plan, '# Riverbend summary\n');
    const made = await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docId: 'riverbend-summary',
        type: 'markdown',
        title: 'Riverbend summary',
        sourceUrl: plan,
      }),
    });
    if (!made.ok) throw new Error(`/docs: ${made.status} ${await made.text()}`);
    const docId = String(((await made.json()) as { docId: string }).docId);
    const docPath = `/workspaces/${ws}/docs/${docId}`;
    const log = new LeadChatLog(dataDir);
    const t0 = Date.now() - 10 * 60_000;
    log.append(ws, {
      id: 'asked',
      role: 'person',
      author: ALICE,
      text: 'Where is the Riverbend summary?',
      ts: t0,
      state: 'answered',
      via: 'chat',
    });
    log.append(ws, {
      id: 'typed',
      role: 'agent',
      author: { id: LEAD.agentId, name: LEAD.agentName },
      text: `It is [the Riverbend summary](${docPath}).`,
      ts: t0 + 1000,
      replyTo: 'asked',
    });

    const homeUrl = `${base}/workspaces/${ws}/home`;
    const cases: VoiceNavCase[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      const cdp = await openBrowser(width, height);
      // On a phone the open panel is a full-screen sheet over the page's
      // links, so the only page link a finger reaches from it is the nav's.
      const ways = [
        ['bar', 'doc'],
        ['panel', 'doc'],
        ['panel', 'nav'],
      ] as const;
      for (const [how, link] of ways.filter(
        ([h, l]) => width > 1100 || h !== 'panel' || l !== 'doc',
      )) {
        step(`${how}, ${link} link, at ${width}`);
        // A fresh tab state for each case: nothing kept from the last one.
        for (let i = 0; i < 2; i++) {
          if (i === 1) await cdp.evaluate('sessionStorage.clear()');
          const loaded = cdp.once('Page.loadEventFired');
          await cdp.send('Page.navigate', { url: homeUrl });
          await loaded;
        }
        const btn = await until('the agent button', async () => {
          return (await cdp.evaluate(BUTTON)) as { x: number; y: number } | null;
        });
        // Voice first: the first tap brings the bar out and listens.
        await tap(cdp, btn);
        await until('listening from the bar', async () => {
          const r = await read(cdp);
          return r.listening && r.barOut ? r : null;
        });
        if (how === 'panel') {
          const bar = await until('the bar', async () => {
            return (await cdp.evaluate(centreOf('.lc-bar'))) as { x: number; y: number } | null;
          });
          await tap(cdp, bar);
          await until('the panel open, still listening', async () => {
            const r = await read(cdp);
            return r.listening && r.paneOpen ? r : null;
          });
        }
        const before = await read(cdp);
        if (shots) await shot(cdp, join(shots, `voice-nav-${how}-${link}-${width}-before.png`));
        // Follow a link on the page, with a real tap: a link to one of the
        // board's docs, or the side nav's Tasks.
        await cdp.evaluate('window.__cwSamePage = true');
        const target = await until(`the ${link} link`, async () => {
          return (await cdp.evaluate(link === 'doc' ? PLANT_DOC_LINK(docPath) : NAV_TASKS)) as {
            x: number;
            y: number;
          } | null;
        });
        await tap(cdp, target);
        const goal = link === 'doc' ? docPath : `/workspaces/${ws}/tasks`;
        await until(`the ${link} page`, async () => {
          const here = String(await cdp.evaluate('location.pathname'));
          return here === goal || (link === 'nav' && here === `/workspaces/${ws}`) ? here : null;
        });
        // A full load wipes the marker; a route change inside the page keeps it.
        const fullLoad = (await cdp.evaluate('window.__cwSamePage !== true')) === true;
        const landed = String(await cdp.evaluate('location.pathname'));
        step(`landed ${landed}, full load: ${fullLoad}`);
        // The chat on the new page settles: its client loads, and voice comes
        // back on by itself if it is going to. Nothing on this page is tapped.
        await until('the agent button on the new page', async () => {
          const r = await read(cdp);
          return r.button ? r : null;
        });
        // Only microphone frames the new page sends count.
        const from = mic.frames;
        const fresh = (): number => mic.frames - from;
        const after = await until(
          'voice back on, or the page settled without it',
          async () => {
            const r = await read(cdp);
            return r.listening && fresh() > 0 ? r : null;
          },
          6000,
        ).catch(() => read(cdp));
        if (shots) await shot(cdp, join(shots, `voice-nav-${how}-${link}-${width}-after.png`));
        cases.push({ width, how, link, before, after, landed, fullLoad, framesAfter: fresh() });
      }
      cdp.close();
    }
    const run: VoiceNavRun = { docPath, cases };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
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
