#!/usr/bin/env bun
/**
 * The lead chat on the cross-board review (`/review`), in headless Chromium
 * against a real server and the real bundles, at 1180x820 and 430x932.
 *
 * Two boards, Harborlight and Riverbend, each with its own lead and one open
 * review item. The driver opens `/review` on the first card, taps the agent
 * button and reads which lead the chat names; posts a flush of text as that
 * lead and as the other board's lead, and reads which reached the open chat;
 * closes it, taps Skip, opens it again and reads the lead once more. It also
 * reads where the button sits on the first card's own board page, to compare.
 *
 * Spawned by `review-lead-chat-browser.test.ts`, which reads the JSON it
 * prints. `REVIEW_LEAD_CHAT_SHOTS=<dir>` also writes a screenshot per width.
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
import { agentStream } from '../../server/test/agent-voice-stream.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';
import type {
  Box,
  ReviewLeadChatRun,
  ReviewLeadChatWidthRun,
} from './review-lead-chat-browser-reading.ts';

const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };
const BOARDS = ['Harborlight', 'Riverbend'] as const;

const step = (what: string): void => {
  process.stderr.write(`[review-lead-chat] ${what}\n`);
};

async function until<T>(
  what: string,
  read: () => Promise<T | null> | T | null,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined && v !== false) return v;
    await sleep(25);
  }
  throw new Error(`never happened: ${what}`);
}

const SR = `document.querySelector('[data-lead-chat="layer"]')?.shadowRoot`;

/** The visible agent button (there is one per page), the pane and its rows. */
const STATE = `(() => {
  const hosts = [...document.querySelectorAll('[data-lead-chat="button"]')].filter((h) => !h.hidden);
  const host = hosts[0];
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const b = btn ? btn.getBoundingClientRect() : null;
  const sr = ${SR};
  const pane = sr && sr.querySelector('.lc-pane');
  const who = sr && sr.querySelector('.lc-title p');
  return {
    button: b && b.width > 0 ? { left: b.left, top: b.top, width: b.width, height: b.height } : null,
    hosts: hosts.length,
    inDock: !!host && !!host.closest('#board-nav .board-nav-dock'),
    open: !!pane && !pane.hidden && pane.getAnimations().length === 0,
    who: who ? who.textContent : null,
    texts: sr ? [...sr.querySelectorAll('.lc-msg .lc-msg-text')].map((x) => x.textContent) : [],
    project: document.getElementById('board-ws-name-text')?.textContent ?? '',
  };
})()`;

interface State {
  button: Box | null;
  hosts: number;
  inDock: boolean;
  open: boolean;
  who: string | null;
  texts: string[];
  project: string;
}

const round = (b: Box | null): Box | null =>
  b
    ? {
        left: Math.round(b.left),
        top: Math.round(b.top),
        width: Math.round(b.width),
        height: Math.round(b.height),
      }
    : null;

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function openBrowser(width: number, height: number): Promise<Cdp> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile, ['--mute-audio']),
    STARTUP_TIMEOUT_MS,
    `review-lead-chat-${width}-${process.pid}`,
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
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
  });
  return cdp;
}

const state = async (cdp: Cdp): Promise<State> => (await cdp.evaluate(STATE)) as State;

async function tap(cdp: Cdp, x: number, y: number): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
    });
  }
}

const centre = (b: Box): { x: number; y: number } => ({
  x: b.left + b.width / 2,
  y: b.top + b.height / 2,
});

/** Load a page; the button's state once it shows, or null if it never does. */
async function load(cdp: Cdp, url: string): Promise<State | null> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  return until(
    'the agent button',
    async () => {
      const s = await state(cdp);
      return s.button ? s : null;
    },
    10_000,
  ).catch(() => null);
}

async function openChat(cdp: Cdp, button: Box, lead: string): Promise<State> {
  await tap(cdp, centre(button).x, centre(button).y);
  return until(
    `the chat open on ${lead}`,
    async () => {
      const s = await state(cdp);
      return s.open && s.who === lead ? s : null;
    },
    10_000,
  ).catch(async () => state(cdp));
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'review-lead-chat-'));
  const shots = process.env.REVIEW_LEAD_CHAT_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let handle: ServerHandle | undefined;
  const streams: Array<{ close(): void }> = [];
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
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
      spawnerAgentId: null,
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

    step('two boards, each with a lead and an open review item');
    const wsOf: Record<string, string> = {};
    const leads: Record<string, string> = {};
    for (const name of BOARDS) {
      const ws = (
        (await post('/workspaces', { name, author: ALICE })) as { workspace: { id: string } }
      ).workspace.id;
      const lead = { agentId: `${name.toLowerCase()}-lead`, agentName: `${name} Lead` };
      server.tasks.attachAgent(ws, { ...lead, runtime: 'claude-code-local' });
      server.tasks.setLeadAgent(ws, lead.agentId, { actor: ALICE });
      streams.push(await agentStream(base, ws, lead.agentId));
      const author = { id: lead.agentId, name: lead.agentName, kind: 'agent' };
      const { task } = (await post(`/workspaces/${ws}/tasks`, {
        title: `${name} tide table`,
        body: 'Alice can read the tides so that sailors plan.',
        author,
      })) as { task: { id: string } };
      await post(`/workspaces/${ws}/tasks/${task.id}/review-items`, {
        review: {
          shape: 'decision',
          headline: `Which tide table goes on the ${name} front page?`,
          detail: 'The gauge is closer; the buoy is steadier.',
          options: [
            { id: 'gauge', label: 'Gauge' },
            { id: 'buoy', label: 'Buoy' },
          ],
        },
        author,
      });
      wsOf[name] = ws;
      leads[name] = lead.agentName;
    }
    const queue = (await (await fetch(`${base}/api/review-queue`)).json()) as {
      items: Array<{ key: string; workspaceId: string; project: string }>;
    };
    const [first, second] = queue.items;
    if (!first || !second) throw new Error(`queue holds ${queue.items.length} items, not 2`);
    const leadOf = (project: string): string => leads[project] ?? '?';
    const flush = (project: string, text: string, n: string) =>
      post(`/workspaces/${wsOf[project]}/agents/${encodeURIComponent(leadOf(project))}/mirror`, {
        kind: 'text',
        messageId: `msg-${n}`,
        index: 0,
        final: true,
        text,
      });

    const widths: ReviewLeadChatWidthRun[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      step(`/review at ${width}`);
      const cdp = await openBrowser(width, height);
      const run: ReviewLeadChatWidthRun = {
        width,
        firstProject: first.project,
        firstLead: null,
        inDock: false,
        buttonClosed: null,
        buttonOpen: null,
        boardButton: null,
        liveWithin1s: false,
        otherLeadShown: false,
        secondProject: second.project,
        secondLead: null,
        buttonAfterSkip: null,
      };
      const boardState = await load(cdp, `${base}/workspaces/${wsOf[first.project]}`);
      run.boardButton = round(boardState?.button ?? null);

      const loaded = await load(cdp, `${base}/review?item=${encodeURIComponent(first.key)}`);
      if (loaded?.button) {
        run.inDock = loaded.inDock;
        run.buttonClosed = round(loaded.button);
        const opened = await openChat(cdp, loaded.button, leadOf(first.project));
        run.firstLead = opened.who;
        run.buttonOpen = round(opened.button);

        step(`a lead's text reaches the open chat at ${width}`);
        const mine = `Reading the ${first.project} tides at ${width}.`;
        const theirs = `Reading the ${second.project} tides at ${width}.`;
        await flush(second.project, theirs, `other-${width}`);
        await flush(first.project, mine, `mine-${width}`);
        run.liveWithin1s = await until(
          'the flush on the page',
          async () => ((await state(cdp)).texts.includes(mine) ? true : null),
          1000,
        ).catch(() => false);
        run.otherLeadShown = (await state(cdp)).texts.includes(theirs);
        if (shots) {
          const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
            data: string;
          };
          writeFileSync(
            join(shots, `review-lead-chat-${width}.png`),
            Buffer.from(png.data, 'base64'),
          );
        }

        step(`close, skip to the next card, open again at ${width}`);
        const open = await state(cdp);
        if (open.button) await tap(cdp, centre(open.button).x, centre(open.button).y);
        await until(
          'the chat closed',
          async () => ((await state(cdp)).open ? null : true),
          5000,
        ).catch(() => null);
        const skip = (await cdp.evaluate(`(() => {
          const b = document.querySelector('.board-walk-skip');
          if (!b) return null;
          b.scrollIntoView({ block: 'center' });
          const r = b.getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        })()`)) as Box | null;
        if (skip) {
          await tap(cdp, centre(skip).x, centre(skip).y);
          const moved = await until(
            'the second card',
            async () => {
              const s = await state(cdp);
              return s.project === second.project && s.button ? s : null;
            },
            10_000,
          ).catch(() => null);
          if (moved?.button) {
            const again = await openChat(cdp, moved.button, leadOf(second.project));
            run.secondLead = again.who;
            const shut = await state(cdp);
            if (shut.button) await tap(cdp, centre(shut.button).x, centre(shut.button).y);
            const closed = await until(
              'the chat closed again',
              async () => {
                const s = await state(cdp);
                return s.open ? null : s;
              },
              5000,
            ).catch(() => null);
            run.buttonAfterSkip = round(closed?.button ?? null);
          }
        }
      }
      widths.push(run);
      cdp.close();
    }
    const out: ReviewLeadChatRun = { widths, leads };
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
  } finally {
    for (const s of streams) s.close();
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
