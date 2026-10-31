#!/usr/bin/env bun
/**
 * The lead chat in headless Chromium against a real server and the real
 * bundles: on the board, its Home, a doc and a mock, at 1180x820 and at
 * 430x932, a tap on the agent button opens the chat, a typed message reaches
 * the board's lead, and the lead's answer appears in the open panel. Then, in
 * Voice first, a tap brings out the bar attached to the button, the page
 * streams its mic over the converse socket, the lead hears the question and
 * its answer comes back into the bar, and the page listens again.
 *
 * No real device and no billed engine: the microphone is Chrome's fake
 * device, audio output is muted, and the server's listener and voice are
 * scripted fakes — the listener "hears" whatever line this driver set once
 * frames arrive. The lead is an agent stream this driver holds; it answers
 * through the same route `answer_voice` calls.
 *
 * Spawned by `lead-chat-browser.test.ts`, which reads the JSON it prints.
 * `LEAD_CHAT_SHOTS=<dir>` also writes a screenshot of every open panel.
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
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import type { SpokenVoice } from '../../server/src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../../server/src/transcribe.ts';
import { agentStream } from '../../server/test/agent-voice-stream.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';
import type { LeadChatRun, Rect, SurfaceRun, VoiceRun } from './lead-chat-browser-reading.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-driver] ${what}\n`);
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
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

/** Everything the page shows of the chat, read through its shadow roots. */
const READ = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const layer = document.querySelector('[data-lead-chat="layer"]');
  const sr = layer && layer.shadowRoot;
  const pane = sr && sr.querySelector('.lc-pane');
  const bar = sr && sr.querySelector('.lc-bar');
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
  const shown = (el) => !!el && !el.hidden && el.getBoundingClientRect().width > 0;
  const b = btn && btn.getBoundingClientRect();
  const hit = b ? document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) : null;
  return {
    button: shown(btn) ? box(btn) : null,
    buttonOnTop: !!hit && hit === host,
    expanded: btn ? btn.getAttribute('aria-expanded') : null,
    // Read once the grow has finished: mid-grow the box is the button's.
    pane: shown(pane) && pane.getAnimations().length === 0 ? box(pane) : null,
    bar: shown(bar) ? box(bar) : null,
    close: sr && shown(sr.querySelector('.lc-close')) ? box(sr.querySelector('.lc-close')) : null,
    barText: bar ? bar.textContent : '',
    list: sr && sr.querySelector('.lc-list') ? sr.querySelector('.lc-list').textContent : '',
    composerFocused: !!sr && sr.activeElement === sr.querySelector('textarea'),
    listening: btn ? btn.dataset.listening === 'true' : false,
    // Every control on screen in the chat that would start or stop listening.
    listenControls: sr ? [...sr.querySelectorAll('button')].filter((x) => shown(x) && /listen|talk|mic/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.title || '') + ' ' + x.className)).length : 0,
    viewport: { width: document.documentElement.clientWidth, height: innerHeight, inner: innerWidth, scale: visualViewport ? visualViewport.scale : 1 },
  };
})()`;

interface Read {
  button: Rect | null;
  buttonOnTop: boolean;
  expanded: string | null;
  pane: Rect | null;
  bar: Rect | null;
  close: Rect | null;
  barText: string;
  list: string;
  composerFocused: boolean;
  listening: boolean;
  listenControls: number;
  viewport: { width: number; height: number; inner?: number; scale?: number };
}

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function openBrowser(width: number, height: number): Promise<Cdp> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) =>
      chromeLaunchArgs({ width, height }, profile, [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--mute-audio',
      ]),
    STARTUP_TIMEOUT_MS,
    `lead-chat-${width}-${process.pid}`,
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
  // A returning reader, so no name prompt sits over the page.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
  });
  return cdp;
}

async function go(cdp: Cdp, url: string): Promise<Read> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  return until('the agent button on the page', async () => {
    const r = (await cdp.evaluate(READ)) as Read;
    return r.button ? r : null;
  });
}

/** A real tap at the centre of a box, so a covered button fails here. */
async function tap(cdp: Cdp, r: Rect): Promise<void> {
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-'));
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
    // The listener hears `ears.line` on the second frame after it is set.
    const ears = { line: null as string | null, opens: 0, frames: 0 };
    const listener: TranscriptionEngine = {
      name: 'scripted',
      async open(o) {
        ears.opens++;
        let n = 0;
        return {
          send: () => {
            ears.frames++;
            if (ears.line && ++n >= 2) {
              const text = ears.line;
              ears.line = null;
              o.onTurn({ turn: 0, text, final: true });
            }
          },
          close: async () => {},
        };
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
    const author = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author })) as { workspace: { id: string } }
    ).workspace.id;
    server.tasks.attachAgent(ws, { ...LEAD, runtime: 'claude-code-local' });
    server.tasks.setLeadAgent(ws, LEAD.agentId, {
      actor: { id: 'known-alice', name: 'Alice', kind: 'known' },
    });
    lead = await agentStream(base, ws, LEAD.agentId);
    const leadStream = lead;

    const plan = join(dir, 'saltmarsh-plan.md');
    writeFileSync(plan, '# Saltmarsh signup\n\nThe email field is the last one left.\n');
    const doc = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'saltmarsh-plan',
          type: 'markdown',
          sourceUrl: plan,
        })
      ).docId,
    );
    const mockFile = join(dir, 'signup.html');
    writeFileSync(
      mockFile,
      '<!doctype html><html><head><title>Signup</title></head><body><h1>Join Saltmarsh</h1></body></html>',
    );
    const mock = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'signup-mock',
          type: 'mockup',
          sourceUrl: mockFile,
        })
      ).docId,
    );
    await post(`/workspaces/${ws}/docs:attach`, { docId: mock });

    const surfaces: Array<[string, string]> = [
      ['board', `${base}/workspaces/${ws}`],
      ['home', `${base}/workspaces/${ws}/home`],
      ['doc', `${base}/workspaces/${ws}/docs/${doc}`],
      ['mock', `${base}/workspaces/${ws}/mockups/${mock}`],
    ];
    const runs: SurfaceRun[] = [];
    const voice: VoiceRun[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      const cdp = await openBrowser(width, height);
      for (const [surface, url] of surfaces) {
        step(`${surface} at ${width}`);
        const before = await go(cdp, url);
        // Chat first, the default: one tap opens the panel with the cursor in it.
        await tap(cdp, before.button as Rect);
        const open = await until('the panel open', async () => {
          const r = (await cdp.evaluate(READ)) as Read;
          return r.pane ? r : null;
        });
        const text = `What is left on the ${surface} at ${width}?`;
        await cdp.send('Input.insertText', { text });
        for (const type of ['keyDown', 'keyUp']) {
          await cdp.send('Input.dispatchKeyEvent', {
            type,
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
          });
        }
        const frame = await until(
          `the lead hears "${text}"`,
          () => leadStream.voice.find((v) => v.transcript === text) ?? null,
        );
        const answer = `On the ${surface} at ${width}: the email field.`;
        const answered = Date.now();
        await post(`/workspaces/${ws}/voice-queue/${frame.queueId}/answer`, {
          agentId: LEAD.agentId,
          text: answer,
        });
        const shown = await until('the answer in the open panel', async () => {
          const r = (await cdp.evaluate(READ)) as Read;
          return r.list.includes(answer) ? r : null;
        });
        const answerMs = Date.now() - answered;
        if (shots) {
          const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
            data: string;
          };
          writeFileSync(
            join(shots, `lead-chat-${surface}-${width}.png`),
            Buffer.from(png.data, 'base64'),
          );
        }
        // Chat first listens from the first tap; open, the agent button
        // stops and starts listening, and only Close closes.
        const listeningOnOpen = await until('listening from the first tap', async () => {
          const r = (await cdp.evaluate(READ)) as Read;
          return r.listening ? true : null;
        }).catch(() => false);
        await tap(cdp, shown.button as Rect);
        const paused = await until('listening stopped, panel open', async () => {
          const r = (await cdp.evaluate(READ)) as Read;
          return r.listening ? null : r;
        });
        await tap(cdp, shown.button as Rect);
        const resumed = await until('listening again, panel open', async () => {
          const r = (await cdp.evaluate(READ)) as Read;
          return r.listening ? r : null;
        });
        await tap(cdp, resumed.close as Rect);
        const closed = await until('the panel closed', async () => {
          const r = (await cdp.evaluate(READ)) as Read;
          return r.pane ? null : r;
        });
        runs.push({
          surface,
          width,
          buttonBefore: before.button,
          buttonOnTop: before.buttonOnTop,
          buttonOpen: open.button,
          composerFocused: open.composerFocused,
          pane: open.pane,
          viewport: open.viewport,
          leadHeard: frame.transcript ?? null,
          context: (frame as { context?: { surface?: string } }).context?.surface ?? null,
          answerShown: shown.list.includes(answer),
          answerMs,
          closedAfter: closed.pane === null && closed.expanded === 'false',
          listeningOnOpen,
          listenControls: open.listenControls,
          pausedOpen: paused.pane !== null,
          resumedOpen: resumed.pane !== null,
          listeningAfterClose: closed.listening,
        });
      }

      step(`Voice first on the board at ${width}`);
      await go(cdp, surfaces[0]?.[1] ?? '');
      // Chosen where a person chooses it: Settings, Notifications, the Voice row.
      await cdp.evaluate(`document.getElementById('board-nav-settings').click()`);
      await cdp.evaluate(
        `document.querySelector('.settings-subnav a[data-type="notifications"], #board-settings-types a[data-type="notifications"]').click()`,
      );
      const row = await until('the Voice row on screen', async () => {
        const r = (await cdp.evaluate(`(() => {
          const s = document.getElementById('board-lead-chat-mode');
          const b = s && s.getBoundingClientRect();
          // Margin box: the checkbox carries the browser's default margin.
          const edge = (el) => el.getBoundingClientRect().right + parseFloat(getComputedStyle(el).marginRight);
          const t = document.getElementById('board-push-toggle');
          return b && b.width > 0 ? { value: s.value, right: edge(s), toggleRight: edge(t) } : null;
        })()`)) as { value: string; right: number; toggleRight: number } | null;
        return r;
      });
      if (shots) {
        const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
          data: string;
        };
        writeFileSync(
          join(shots, `lead-chat-settings-${width}.png`),
          Buffer.from(png.data, 'base64'),
        );
      }
      await cdp.evaluate(`(() => {
        const s = document.getElementById('board-lead-chat-mode');
        s.value = 'voice';
        s.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      const stored = String(await cdp.evaluate(`localStorage.getItem('cw.lead-chat.mode')`));
      await go(cdp, surfaces[0]?.[1] ?? '');
      const v0 = (await cdp.evaluate(READ)) as Read;
      // Read before the tap: the question's listener may open before the bar is seen.
      const opensBefore = ears.opens;
      await tap(cdp, v0.button as Rect);
      const out = await until('the bar out', async () => {
        const r = (await cdp.evaluate(READ)) as Read;
        return r.bar ? r : null;
      });
      const said = `Read me the next one at ${width}`;
      ears.line = said;
      const heard = await until(
        'the lead hears the spoken question',
        () => leadStream.voice.find((v) => v.transcript === said) ?? null,
      );
      const reply = `Spoken answer at ${width}: the ferry task.`;
      await post(`/workspaces/${ws}/voice-queue/${heard.queueId}/answer`, {
        agentId: LEAD.agentId,
        text: reply,
      });
      const answered = await until('the spoken answer in the bar', async () => {
        const r = (await cdp.evaluate(READ)) as Read;
        return r.barText.includes(reply) ? r : null;
      });
      // Said, then the next question listens by itself: a second listener.
      const relistened = await until('listening again', () =>
        ears.opens >= opensBefore + 2 ? ears.opens - opensBefore : null,
      );
      if (shots) {
        const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
          data: string;
        };
        writeFileSync(
          join(shots, `lead-chat-voice-bar-${width}.png`),
          Buffer.from(png.data, 'base64'),
        );
      }
      // The bar grows into the panel, still listening; the agent button is
      // the one listen control, and its tap stops listening and closes.
      await tap(cdp, out.bar as Rect);
      const grown = await until('the panel open from the bar', async () => {
        const r = (await cdp.evaluate(READ)) as Read;
        return r.pane ? r : null;
      });
      await tap(cdp, grown.button as Rect);
      const stopped = await until('listening stopped in the open panel', async () => {
        const r = (await cdp.evaluate(READ)) as Read;
        return r.listening ? null : r;
      });
      await tap(cdp, stopped.close as Rect);
      const off = await until('the chat closed', async () => {
        const r = (await cdp.evaluate(READ)) as Read;
        return r.bar || r.pane ? null : r;
      });
      const snap = (await (await fetch(`${base}/workspaces/${ws}/lead-chat`)).json()) as {
        messages: Array<{ text: string; via?: string; role: string }>;
      };
      voice.push({
        width,
        settingsDefault: row.value,
        settingsRight: row.right,
        toggleRight: row.toggleRight,
        settingsStored: stored,
        button: out.button,
        bar: out.bar,
        barText: out.barText,
        viewport: out.viewport,
        framesHeard: ears.frames,
        listens: relistened,
        leadHeard: heard.transcript ?? null,
        storedVia: snap.messages.find((m) => m.text === said)?.via ?? null,
        answerInBar: answered.barText.includes(reply),
        answerStored: snap.messages.some((m) => m.role === 'agent' && m.text === reply),
        barGone: off.bar === null,
        listeningOut: out.listening,
        listenControlsOut: out.listenControls,
        listeningInPane: grown.listening,
        listenControlsInPane: grown.listenControls,
        listeningAfter: stopped.listening,
        paneKept: stopped.pane !== null,
        paneGone: off.pane === null,
      });
      await cdp.evaluate(`localStorage.removeItem('cw.lead-chat.mode')`);
      cdp.close();
    }

    const run: LeadChatRun = { surfaces: runs, voice };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    lead?.close();
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 230s');
  void Promise.all(browsers.map((b) => stopBrowser(b.proc, b.profile))).finally(() =>
    process.exit(3),
  );
}, 230_000).unref();
await main();
process.exit(0);
