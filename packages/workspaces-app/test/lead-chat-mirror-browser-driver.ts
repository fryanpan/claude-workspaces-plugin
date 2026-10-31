#!/usr/bin/env bun
/**
 * The lead chat's mirror of the lead's session, in headless Chromium against
 * a real server and the real bundles, on the board at 1180x820 and 430x932.
 *
 * The lead's session posts a board event, a tool call and, later, a flush of
 * text through the routes its hooks use; a spoken question and its answer
 * are in the log. The driver taps the tool call open, hides the board events
 * with the header's toggle, opens the spoken reply's words, and watches the
 * text flush arrive. Wide, it drags the docked panel's edge and loads the
 * page again: the panel is open, at the width it was left.
 *
 * Spawned by `lead-chat-mirror-browser.test.ts`, which reads the JSON it
 * prints. `LEAD_CHAT_SHOTS=<dir>` also writes a screenshot of each panel.
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
import { agentStream } from '../../server/test/agent-voice-stream.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';
import type { MirrorRun, MirrorWidthRun } from './lead-chat-mirror-browser-reading.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-mirror] ${what}\n`);
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

/** Runs inside the page: the layer's shadow root, and helpers on it. */
const SR = `document.querySelector('[data-lead-chat="layer"]')?.shadowRoot`;

const STATE = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const sr = ${SR};
  const pane = sr && sr.querySelector('.lc-pane');
  const b = btn ? btn.getBoundingClientRect() : null;
  const p = pane && !pane.hidden ? pane.getBoundingClientRect() : null;
  const grip = sr && sr.querySelector('.lc-grip');
  const g = grip ? grip.getBoundingClientRect() : null;
  return {
    button: b && b.width > 0 ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null,
    open: !!pane && !pane.hidden && pane.getAnimations().length === 0,
    rows: sr ? sr.querySelectorAll('.lc-list > *').length : 0,
    texts: sr ? [...sr.querySelectorAll('.lc-msg .lc-msg-text')].map((x) => x.textContent) : [],
    pane: p ? { left: p.left, right: p.right, width: p.width, top: p.top, bottom: p.bottom } : null,
    docked: !!pane && pane.classList.contains('lc-dock') && document.documentElement.dataset.lcDocked === 'true',
    sheet: !!pane && pane.classList.contains('lc-sheet'),
    vw: document.documentElement.clientWidth,
    grip: g && g.width > 0 ? { x: g.left + g.width / 2, y: g.top + g.height / 2 } : null,
  };
})()`;

interface State {
  button: { x: number; y: number } | null;
  open: boolean;
  rows: number;
  texts: string[];
  pane: { left: number; right: number; width: number; top: number; bottom: number } | null;
  docked: boolean;
  sheet: boolean;
  vw: number;
  grip: { x: number; y: number } | null;
}

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function openBrowser(width: number, height: number): Promise<Cdp> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile, ['--mute-audio']),
    STARTUP_TIMEOUT_MS,
    `lead-chat-mirror-${width}-${process.pid}`,
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

async function mouse(cdp: Cdp, type: string, x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
  });
}

async function tap(cdp: Cdp, x: number, y: number): Promise<void> {
  await mouse(cdp, 'mousePressed', x, y);
  await mouse(cdp, 'mouseReleased', x, y);
}

/** Tap the element `selector` names inside the chat's layer, where it is. */
async function tapIn(cdp: Cdp, selector: string): Promise<void> {
  const at = (await cdp.evaluate(`(() => {
    const el = ${SR}.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 };
  })()`)) as { x: number; y: number } | null;
  if (!at) throw new Error(`nothing to tap: ${selector}`);
  await tap(cdp, at.x, at.y);
}

const inLayer = async <T>(cdp: Cdp, body: string): Promise<T> =>
  (await cdp.evaluate(`(() => { const sr = ${SR}; ${body} })()`)) as T;

async function load(cdp: Cdp, url: string): Promise<State> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  return until('the agent button', async () => {
    const s = await state(cdp);
    return s.button ? s : null;
  });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-mirror-'));
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
    const dataDir = join(dir, 'data');
    handle = createServer({
      port: 0,
      dataDir,
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

    // A spoken question and the lead's answer, already in the log.
    const log = new LeadChatLog(dataDir);
    const t0 = Date.now() - 60_000;
    log.append(ws, {
      id: 'spoken',
      role: 'person',
      author: ALICE,
      text: 'What is left on Saltmarsh?',
      ts: t0,
      via: 'voice',
      state: 'answered',
    });
    log.append(ws, {
      id: 'reply',
      role: 'agent',
      author: { id: LEAD.agentId, name: LEAD.agentName },
      text: 'Two tasks, both in review.',
      ts: t0 + 1,
      replyTo: 'spoken',
    });
    // What the lead's hooks post.
    const agent = `/workspaces/${ws}/agents/${encodeURIComponent(LEAD.agentName)}`;
    await post(`${agent}/prompts`, {
      typed: false,
      channel: { author: 'Riverbend', text: 'replied on Deploy plan: the install takes 40s' },
    });
    await post(`${agent}/mirror`, {
      kind: 'tools',
      calls: [{ name: 'Bash', input: 'git status --short', output: ' M deploy.ts' }],
    });

    const boardUrl = `${base}/workspaces/${ws}`;
    const widths: MirrorWidthRun[] = [];
    for (const [width, height] of [
      [1180, 820],
      [1000, 800],
      [430, 932],
    ] as const) {
      step(`open the chat at ${width}`);
      const cdp = await openBrowser(width, height);
      const first = await load(cdp, boardUrl);
      if (!first.button) throw new Error('no button');
      // The bar's tabs with the chat closed, to compare with it open.
      const tabsClosed = (await cdp.evaluate(
        `[...document.querySelectorAll('.board-nav > .board-nav-item, .board-nav > .board-nav-dock')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return (e.dataset.nav ?? 'agent') + ' ' + [r.left, r.top, r.width, r.height].map(Math.round).join(','); })`,
      )) as string[];
      await tap(cdp, first.button.x, first.button.y);
      await until('the panel open with rows', async () => {
        const s = await state(cdp);
        return s.open && s.rows > 2 ? s : null;
      });

      step(`tool call at ${width}`);
      const head = await inLayer<string>(
        cdp,
        `return sr.querySelector('.lc-tool .lc-row-head').textContent;`,
      );
      await tapIn(cdp, '.lc-tool .lc-row-head');
      const open = await until('the tool call open', () =>
        inLayer<string[] | null>(
          cdp,
          `const b = sr.querySelector('.lc-tool .lc-row-body'); return b ? [...b.querySelectorAll('pre')].map((p) => p.textContent) : null;`,
        ),
      );
      const expanded = await inLayer<string | null>(
        cdp,
        `return sr.querySelector('.lc-tool .lc-row-head').getAttribute('aria-expanded');`,
      );

      step(`board events toggle at ${width}`);
      // The header holds one row: neither the title nor the toggle's label wraps, and the
      // toggle sits level with the close button.
      const headerOneRow = await inLayer<boolean>(
        cdp,
        `const t = sr.querySelector('.lc-chan-toggle'); const lab = t.children[1];` +
          ' const lh = parseFloat(getComputedStyle(lab).lineHeight) || 1.4 * parseFloat(getComputedStyle(lab).fontSize);' +
          ' const mid = (e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; };' +
          ` const h2 = sr.querySelector('.lc-title h2'); const h2lh = parseFloat(getComputedStyle(h2).lineHeight);` +
          ` return lab.textContent === 'Board events' && lab.getBoundingClientRect().height <= lh * 1.5` +
          ` && h2.textContent === 'Your agent' && h2.getBoundingClientRect().height <= h2lh * 1.5` +
          ` && Math.abs(mid(t) - mid(sr.querySelector('.lc-close'))) < 8;`,
      );
      const chanCount = `return sr.querySelectorAll('.lc-chan').length;`;
      const before = await inLayer<number>(cdp, chanCount);
      await tapIn(cdp, '.lc-chan-toggle');
      const hidden = await until('board events hidden', async () => {
        const n = await inLayer<number>(cdp, chanCount);
        return n === 0 ? n : null;
      }).catch(() => -1);
      const count = await inLayer<string>(
        cdp,
        `return sr.querySelector('.lc-chan-count').textContent;`,
      );
      await tapIn(cdp, '.lc-chan-toggle');
      const after = await until('board events back', async () => {
        const n = await inLayer<number>(cdp, chanCount);
        return n > 0 ? n : null;
      }).catch(() => 0);

      step(`spoken reply at ${width}`);
      const closedText = await inLayer<boolean>(
        cdp,
        `return sr.querySelector('.lc-voice').textContent.includes('both in review');`,
      );
      await tapIn(cdp, '.lc-voice-btn');
      const words = await until('the spoken words open', () =>
        inLayer<string | null>(
          cdp,
          `const t = sr.querySelector('.lc-voice-text'); return t ? t.textContent : null;`,
        ),
      );
      const label = await inLayer<string>(
        cdp,
        `return sr.querySelector('.lc-voice-btn').textContent;`,
      );

      step(`a text flush reaches the open chat at ${width}`);
      const flush = `Reading the deploy log at ${width}.`;
      await post(`${agent}/mirror`, {
        kind: 'text',
        messageId: `msg-${width}`,
        index: 0,
        final: true,
        text: flush,
      });
      const liveWithin1s = await until(
        'the flush on the page',
        async () => ((await state(cdp)).texts.includes(flush) ? true : null),
        1000,
      ).catch(() => false);

      const placed = await state(cdp);
      const layout = {
        docked: placed.docked,
        sheet: placed.sheet,
        right: Math.round(placed.pane?.right ?? 0),
        width: Math.round(placed.pane?.width ?? 0),
        vw: placed.vw,
      };
      if (shots) {
        const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
          data: string;
        };
        writeFileSync(
          join(shots, `lead-chat-mirror-${width}.png`),
          Buffer.from(png.data, 'base64'),
        );
      }

      // Full screen at a narrow width: the pane from the top down to the
      // navbar pinned at the bottom; a page tapped there closes the chat.
      let full: MirrorWidthRun['full'] = null;
      if (placed.sheet) {
        step(`full screen and the navbar at ${width}`);
        const tabsOpen = (await cdp.evaluate(
          `[...document.querySelectorAll('.board-nav > .board-nav-item, .board-nav > .board-nav-dock')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return (e.dataset.nav ?? 'agent') + ' ' + [r.left, r.top, r.width, r.height].map(Math.round).join(','); })`,
        )) as string[];
        const geo = (await cdp.evaluate(`(() => {
          const nav = document.querySelector('.board-nav').getBoundingClientRect();
          const lib = document.querySelector('.board-nav-item[data-nav="library"]').getBoundingClientRect();
          const items = [...document.querySelectorAll('.board-nav > .board-nav-item, .board-nav > .board-nav-dock')]
            .filter((e) => e.getBoundingClientRect().width > 0)
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
          const agentFirst = items[0]?.classList.contains('board-nav-dock') ?? false;
          return { navTop: nav.top, navBottom: nav.bottom, navLeft: nav.left, navWidth: nav.width,
            vh: innerHeight, agentFirst, lib: { x: lib.left + lib.width / 2, y: lib.top + lib.height / 2 } };
        })()`)) as {
          navTop: number;
          navBottom: number;
          navLeft: number;
          navWidth: number;
          vh: number;
          agentFirst: boolean;
          lib: { x: number; y: number };
        };
        await tap(cdp, geo.lib.x, geo.lib.y);
        const closed = await until('the chat closed by a page tap', async () => {
          const s = await state(cdp);
          return s.open ? null : true;
        }).catch(() => false);
        const page = (await cdp.evaluate(
          `document.querySelector('.board-nav-item[data-nav="library"]').getAttribute('aria-current')`,
        )) as string | null;
        full = {
          paneTop: Math.round(placed.pane?.top ?? -1),
          paneBottom: Math.round(placed.pane?.bottom ?? -1),
          navTop: Math.round(geo.navTop),
          navBottom: Math.round(geo.navBottom),
          navLeft: Math.round(geo.navLeft),
          navWidth: Math.round(geo.navWidth),
          vh: geo.vh,
          agentFirst: geo.agentFirst,
          closedByPageTap: closed,
          libraryCurrent: page,
          tabsClosed,
          tabsOpen,
        };
      }

      let resized: MirrorWidthRun['resized'] = null;
      let afterNav: MirrorWidthRun['afterNav'] = null;
      if (placed.docked && placed.grip) {
        step('drag the docked panel wider, then load the page again');
        const { x, y } = placed.grip;
        await mouse(cdp, 'mousePressed', x, y);
        for (let i = 1; i <= 5; i++) await mouse(cdp, 'mouseMoved', x - i * 20, y);
        await mouse(cdp, 'mouseReleased', x - 100, y);
        const r = await state(cdp);
        resized = { width: Math.round(r.pane?.width ?? 0) };
        await load(cdp, boardUrl);
        const again = await until('the panel open again without a tap', async () => {
          const s = await state(cdp);
          return s.open ? s : null;
        }).catch(() => null);
        afterNav = again
          ? { open: again.open, width: Math.round(again.pane?.width ?? 0), docked: again.docked }
          : { open: false, width: 0, docked: false };
      }

      widths.push({
        width,
        tool: { head, open, expanded },
        channel: { before, hidden, count, after, headerOneRow },
        voice: { closedText, label, words },
        liveWithin1s,
        layout,
        full,
        resized,
        afterNav,
      });
      cdp.close();
    }
    const run: MirrorRun = { widths };
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
