#!/usr/bin/env bun
/**
 * The board's lead speaks into a meeting, in headless Chromium against a
 * real server, the real bundles and the real MCP: Start a meeting from the
 * lead chat, the room says a line, then the lead makes ONE tool call,
 * `say_in_meeting`, through an MCP child spawned from source. The driver
 * reads, at 1180x820 and 430x932:
 *
 *   - the line in the meeting's notes on the recording tab and on a second
 *     tab that is only watching;
 *   - on the recording tab, the page's player scheduling the voiced line
 *     (`AudioBufferSourceNode.start`, counted by a hook installed before the
 *     page's own scripts) and the row marked as played to its end;
 *   - on the watching tab, no audio scheduled at all.
 *
 * No real device and nothing audible: Chrome's fake microphone, muted
 * output, a scripted engine, and a fake voice that answers fixed PCM. No
 * network call leaves the machine.
 *
 * Spawned by `lead-in-meeting-browser.test.ts`, which reads the JSON it
 * prints.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentIdForName } from '@claude-workspaces/core/identity';
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
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';
import type { Rect } from './lead-chat-browser-reading.ts';

const step = (what: string): void => {
  process.stderr.write(`[lead-in-meeting-driver] ${what}\n`);
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

/** Every buffer the page schedules to play, counted before its scripts run. */
const PLAY_HOOK = `(() => {
  window.__cwPlays = [];
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) {
    try { window.__cwPlays.push(this.buffer ? this.buffer.length : 0); } catch {}
    return start.apply(this, a);
  };
})();`;

const READ = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const q = (s) => sr && sr.querySelector(s);
  const box = (el) => { if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; };
  const lead = sr ? [...sr.querySelectorAll('.lc-line[data-lead="1"]')] : [];
  return {
    button: box(btn),
    pane: box(q('.lc-pane')),
    start: box(q('.lc-start')),
    next: q('[data-wiz="next"]') && !q('[data-wiz="next"]').disabled ? box(q('[data-wiz="next"]')) : null,
    go: box(q('[data-wiz="start"]')),
    head: box(q('.lc-meet')),
    end: box(q('.lc-end')),
    notes: q('.lc-notes') && !q('.lc-notes').hidden ? q('.lc-notes').textContent : '',
    lead: lead.map((r) => ({ text: r.textContent, said: r.dataset.said || '', box: box(r) })),
    plays: window.__cwPlays || [],
    viewport: { width: document.documentElement.clientWidth, height: innerHeight },
  };
})()`;

interface Read {
  button: Rect | null;
  pane: Rect | null;
  start: Rect | null;
  next: Rect | null;
  go: Rect | null;
  head: Rect | null;
  end: Rect | null;
  notes: string;
  lead: Array<{ text: string; said: string; box: Rect | null }>;
  plays: number[];
  viewport: { width: number; height: number };
}

export interface LeadInMeetingSize {
  width: number;
  tool: { said?: boolean; played?: boolean };
  voiced: string[];
  recorder: { lead: Read['lead']; plays: number[]; viewport: Read['viewport']; pane: Rect | null };
  watcher: { lead: Read['lead']; plays: number[] };
}

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function setup(cdp: Cdp, width: number, height: number): Promise<Cdp> {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}\n${PLAY_HOOK}`,
  });
  return cdp;
}

async function openBrowser(width: number, height: number) {
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
    `lead-in-meeting-${width}-${process.pid}`,
    (started) => {
      browsers.push(started);
    },
  );
  const main = await setup(
    await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS)),
    width,
    height,
  );
  const res = await fetch(`http://127.0.0.1:${b.port}/json/new?about:blank`, { method: 'PUT' });
  const target = (await res.json()) as { webSocketDebuggerUrl: string };
  const watcher = await setup(await Cdp.connect(target.webSocketDebuggerUrl), width, height);
  return { main, watcher, browser: b };
}

const read = async (cdp: Cdp): Promise<Read> => (await cdp.evaluate(READ)) as Read;

async function go(cdp: Cdp, url: string): Promise<Read> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  return until('the agent button on the page', async () => {
    const r = await read(cdp);
    return r.button ? r : null;
  });
}

async function tap(cdp: Cdp, r: Rect): Promise<void> {
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

/** The lead's MCP, spawned from source and spoken to over JSON-RPC. */
function startMcp(base: string, name: string) {
  const child = spawn('bun', ['run', join(import.meta.dirname, '../../mcp/src/mcp.ts')], {
    env: {
      HOME: process.env.HOME ?? '',
      PATH: process.env.PATH ?? '',
      CW_BASE_URL: base,
      FEEDBACK_BASE_URL: base,
      CW_AGENT_NAME: name,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let id = 1;
  let pending = '';
  const waiters = new Map<number, (v: unknown) => void>();
  child.stdout?.on('data', (d) => {
    pending += d.toString();
    for (let nl = pending.indexOf('\n'); nl !== -1; nl = pending.indexOf('\n')) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      const msg = JSON.parse(line) as { id?: number };
      if (typeof msg.id === 'number') {
        waiters.get(msg.id)?.(msg);
        waiters.delete(msg.id);
      }
    }
  });
  const rpc = (method: string, params: unknown): Promise<unknown> => {
    const n = id++;
    return new Promise((resolve) => {
      waiters.set(n, resolve);
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  };
  return {
    child,
    async init() {
      await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'lead-in-meeting-driver', version: '0' },
      });
      child.stdin?.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
    },
    async call(name: string, args: Record<string, unknown>) {
      const r = (await rpc('tools/call', { name, arguments: args })) as {
        result?: { isError?: boolean; content?: Array<{ text: string }> };
      };
      const text = r.result?.content?.[0]?.text ?? '{}';
      if (r.result?.isError) throw new Error(`${name}: ${text}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-in-meeting-'));
  let handle: ServerHandle | undefined;
  let mcp: ReturnType<typeof startMcp> | undefined;
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

    let turn = 0;
    const ear: { say: ((text: string) => void) | null } = { say: null };
    const engine: TranscriptionEngine = {
      name: 'scripted',
      async open(o) {
        ear.say = (text) => o.onTurn({ turn: turn++, text, final: true });
        return { send: () => {}, close: async () => {} };
      },
    };
    // A tenth of a second of a quiet tone: enough samples to schedule.
    const pcm = new Uint8Array(4800);
    for (let i = 0; i < pcm.length; i += 2) pcm[i + 1] = i % 8 === 0 ? 4 : 0;
    const voiced: string[] = [];
    const voice: SpokenVoice = {
      name: 'fake',
      async speak(text, onAudio) {
        voiced.push(text);
        onAudio(pcm);
      },
    };
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
      transcription: engine,
      spokenReply: { listener: null, voices: { 1: voice, 2: null }, gemini: null },
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
      (await post('/workspaces', { name: 'Harborlight' })) as { workspace: { id: string } }
    ).workspace.id;
    const LEAD = 'Harborlight Lead';
    const leadId = agentIdForName(LEAD);
    server.tasks.attachAgent(ws, {
      agentId: leadId,
      agentName: LEAD,
      runtime: 'claude-code-local',
      pluginVersion: '0.1.347',
    });
    server.tasks.setLeadAgent(ws, leadId, { actor: { id: 'known-alice', name: 'Alice' } });
    const plan = join(dir, 'saltmarsh-plan.md');
    writeFileSync(plan, '# Saltmarsh plan\n');
    const doc = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'saltmarsh-plan',
          type: 'markdown',
          title: 'Saltmarsh plan',
          sourceUrl: plan,
        })
      ).docId,
    );
    const at = (p: string) => `${base}/workspaces/${ws}${p}`;
    step('start the lead’s MCP');
    mcp = startMcp(base, LEAD);
    await mcp.init();

    const sizes: LeadInMeetingSize[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      step(`start a meeting at ${width}`);
      const { main: page, watcher, browser } = await openBrowser(width, height);
      const first = await go(page, at(`/docs/${doc}`));
      await tap(page, first.button as Rect);
      const open = await until('Start a meeting', async () => {
        const r = await read(page);
        return r.start && r.pane ? r : null;
      });
      await tap(page, open.start as Rect);
      const s1 = await until('the wizard', async () => {
        const r = await read(page);
        return r.next ? r : null;
      });
      await tap(page, s1.next as Rect);
      const s2 = await until('step 2', async () => {
        const r = await read(page);
        return r.go ? r : null;
      });
      await tap(page, s2.go as Rect);
      await until('the meeting heading', async () => ((await read(page)).head ? true : null));
      await until('the engine open', () => ear.say);

      await go(watcher, at(''));
      await tap(watcher, (await read(watcher)).button as Rect);
      await until('the watcher shows the meeting', async () =>
        (await read(watcher)).head ? true : null,
      );
      const room = `The Saltmarsh slipway needs pricing, said at ${width}.`;
      ear.say?.(room);
      await until('the room’s line on the recording page', async () =>
        (await read(page)).notes.includes(room) ? true : null,
      );

      step(`the lead speaks at ${width}`);
      const line = `Who is the slipway for, at ${width}?`;
      const tool = await mcp.call('say_in_meeting', { workspaceId: ws, text: line });
      const rec = await until('the lead’s line played on the recording page', async () => {
        const r = await read(page);
        const row = r.lead.find((l) => l.text.includes(line));
        return row?.said === 'said' ? r : null;
      });
      const watch = await until('the lead’s line on the watching tab', async () => {
        const r = await read(watcher);
        return r.lead.some((l) => l.text.includes(line)) ? r : null;
      });
      sizes.push({
        width,
        tool: tool as LeadInMeetingSize['tool'],
        voiced: [...voiced],
        recorder: { lead: rec.lead, plays: rec.plays, viewport: rec.viewport, pane: rec.pane },
        watcher: { lead: watch.lead, plays: watch.plays },
      });

      const end = await read(watcher);
      await tap(watcher, end.end as Rect);
      await until('the meeting ended', async () =>
        (await read(page)).head === null ? true : null,
      );
      page.close();
      watcher.close();
      await stopBrowser(browser.proc, browser.profile);
      const held = browsers.findIndex((x) => x.proc === browser.proc);
      if (held >= 0) browsers.splice(held, 1);
      ear.say = null;
    }
    process.stdout.write(`\n${JSON.stringify({ sizes })}\n`);
  } finally {
    mcp?.child.kill();
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
