#!/usr/bin/env bun
/**
 * The lead chat's history and its markdown, in headless Chromium against a
 * real server and the real bundles, on the board at 1180x820 and 430x932.
 *
 * The board's log already holds more messages than the server keeps in
 * memory. Opening the chat shows the latest ones, the lead's last message
 * drawn as markdown with its script and handler inert; scrolling to the top
 * pages back until the first message, keeping the reader's line in place; a
 * message sent from elsewhere reaches the open chat; and after a reload the
 * chat opens on the conversation as it stood.
 *
 * Spawned by `lead-chat-history-browser.test.ts`, which reads the JSON it
 * prints. `LEAD_CHAT_SHOTS=<dir>` also writes a screenshot of each open panel.
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
import {
  HISTORY_SIZE,
  type HistoryRun,
  type HistoryWidthRun,
  MARKDOWN_SAMPLE,
} from './lead-chat-history-browser-reading.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-history] ${what}\n`);
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

/** The open list, read through the layer's shadow root. */
const READ = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const pane = sr && sr.querySelector('.lc-pane');
  const list = sr && sr.querySelector('.lc-list');
  const b = btn ? btn.getBoundingClientRect() : null;
  const open = !!pane && !pane.hidden && pane.getAnimations().length === 0;
  const msgs = list ? [...list.querySelectorAll('.lc-msg')] : [];
  return {
    button: b && b.width > 0 ? { left: b.left, top: b.top, width: b.width, height: b.height } : null,
    open,
    ids: msgs.map((m) => m.dataset.messageId),
    texts: msgs.map((m) => m.querySelector('.lc-msg-text').textContent),
    history: list && list.querySelector('.lc-history') ? list.querySelector('.lc-history').textContent : null,
    scrollTop: list ? list.scrollTop : 0,
    scrollable: list ? list.scrollHeight > list.clientHeight : false,
  };
})()`;

interface Read {
  button: { left: number; top: number; width: number; height: number } | null;
  open: boolean;
  ids: string[];
  texts: string[];
  history: string | null;
  scrollTop: number;
  scrollable: boolean;
}

/** What the lead's markdown message drew, and whether anything in it ran. */
const MARKDOWN = `(() => {
  const sr = document.querySelector('[data-lead-chat="layer"]').shadowRoot;
  const md = sr.querySelector('.lc-msg[data-message-id="md"] .lc-md');
  const mine = sr.querySelector('.lc-msg[data-message-id="mine"] .lc-msg-text');
  const a = md ? [...md.querySelectorAll('a')] : [];
  return {
    heading: md?.querySelector('.cm-h')?.textContent ?? null,
    bold: md?.querySelector('strong')?.textContent ?? null,
    italic: md?.querySelector('em')?.textContent ?? null,
    inlineCode: md?.querySelector('p code')?.textContent ?? null,
    links: a.map((x) => ({ href: x.getAttribute('href'), text: x.textContent, target: x.getAttribute('target'), rel: x.getAttribute('rel') })),
    bullets: md ? [...md.querySelectorAll('ul li')].map((x) => x.textContent) : [],
    numbered: md ? [...md.querySelectorAll('ol li')].map((x) => x.textContent) : [],
    tableHead: md ? [...md.querySelectorAll('table th')].map((x) => x.textContent) : [],
    tableCells: md ? [...md.querySelectorAll('table td')].map((x) => x.textContent) : [],
    codeBlock: md?.querySelector('pre code')?.textContent ?? null,
    scripts: sr.querySelectorAll('script').length + document.querySelectorAll('.lc-md script').length,
    images: md ? md.querySelectorAll('img').length : -1,
    handlers: md ? [...md.querySelectorAll('*')].filter((el) => [...el.attributes].some((x) => /^on/i.test(x.name))).length : -1,
    ran: window.__leadChatRan ?? null,
    scriptAsText: md ? md.textContent.includes('<script>') : false,
    mineTag: mine ? mine.querySelectorAll('b').length : -1,
    mineText: mine?.textContent ?? null,
  };
})()`;

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function openBrowser(width: number, height: number): Promise<Cdp> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile, ['--mute-audio']),
    STARTUP_TIMEOUT_MS,
    `lead-chat-history-${width}-${process.pid}`,
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

const read = async (cdp: Cdp): Promise<Read> => (await cdp.evaluate(READ)) as Read;

/** Load the page and tap the agent button open; the open list as it stands. */
async function openChat(cdp: Cdp, url: string): Promise<Read> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  const r = await until('the agent button', async () => {
    const x = await read(cdp);
    return x.button ? x : null;
  });
  const btn = r.button;
  if (!btn) throw new Error('no button');
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: btn.left + btn.width / 2,
      y: btn.top + btn.height / 2,
      button: 'left',
      clickCount: 1,
    });
  }
  return until('the panel open with messages', async () => {
    const x = await read(cdp);
    return x.open && x.ids.length > 0 ? x : null;
  });
}

/** Scroll the list to its top until the first message shows, counting the
 *  pages read and checking each kept the reader's line where it was. */
async function scrollToFirst(cdp: Cdp): Promise<{ pages: number; anchorDrift: number[] }> {
  let pages = 0;
  const anchorDrift: number[] = [];
  for (;;) {
    const before = await read(cdp);
    if (before.history?.startsWith('Start of')) return { pages, anchorDrift };
    if (pages > 20) throw new Error('paged more than twenty times');
    // The first message's place in the list, then the scroll that asks for
    // the page before it.
    const anchor = before.ids[0] ?? '';
    const top = (await cdp.evaluate(`(() => {
      const sr = document.querySelector('[data-lead-chat="layer"]').shadowRoot;
      const list = sr.querySelector('.lc-list');
      list.scrollTop = 0;
      list.dispatchEvent(new Event('scroll'));
      const el = list.querySelector('.lc-msg[data-message-id="${anchor}"]');
      return el.getBoundingClientRect().top;
    })()`)) as number;
    await until('the page before', async () => {
      const x = await read(cdp);
      return x.ids.length > before.ids.length || x.history?.startsWith('Start of') ? x : null;
    });
    const after = (await cdp.evaluate(`(() => {
      const sr = document.querySelector('[data-lead-chat="layer"]').shadowRoot;
      return sr.querySelector('.lc-msg[data-message-id="${anchor}"]').getBoundingClientRect().top;
    })()`)) as number;
    anchorDrift.push(Math.round(Math.abs(after - top)));
    pages++;
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-history-'));
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

    // The conversation so far, written to the log before anything reads it,
    // as a server restarted over a long chat finds it.
    const log = new LeadChatLog(dataDir);
    const t0 = Date.now() - HISTORY_SIZE * 60_000;
    for (let i = 0; i < HISTORY_SIZE - 2; i++) {
      const agent = i % 2 === 1;
      log.append(ws, {
        id: `h${i}`,
        role: agent ? 'agent' : 'person',
        author: agent ? { id: LEAD.agentId, name: LEAD.agentName } : ALICE,
        text: `History line ${i}`,
        ts: t0 + i * 60_000,
        ...(agent ? {} : { state: 'answered' as const, via: 'chat' as const }),
      });
    }
    const tLast = t0 + HISTORY_SIZE * 60_000;
    log.append(ws, {
      id: 'mine',
      role: 'person',
      author: ALICE,
      text: 'Is <b>this</b> bold?',
      ts: tLast - 2,
      state: 'answered',
      via: 'chat',
    });
    log.append(ws, {
      id: 'md',
      role: 'agent',
      author: { id: LEAD.agentId, name: LEAD.agentName },
      text: MARKDOWN_SAMPLE,
      ts: tLast - 1,
    });

    const boardUrl = `${base}/workspaces/${ws}`;
    const widths: HistoryWidthRun[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      step(`open the chat at ${width}`);
      const cdp = await openBrowser(width, height);
      const opened = await openChat(cdp, boardUrl);
      const markdown = (await cdp.evaluate(MARKDOWN)) as HistoryWidthRun['markdown'];
      if (shots) {
        await sleep(300);
        const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
          data: string;
        };
        writeFileSync(
          join(shots, `lead-chat-markdown-${width}.png`),
          Buffer.from(png.data, 'base64'),
        );
      }

      step(`a message from elsewhere reaches the open chat at ${width}`);
      const elsewhere = `Sent from another page at ${width}`;
      await post(`/workspaces/${ws}/lead-chat`, { text: elsewhere, author: ALICE });
      const live = await until(
        'the message from elsewhere in the open chat',
        async () => ((await read(cdp)).texts.includes(elsewhere) ? true : null),
        1000,
      ).catch(() => false);

      step(`scroll back to the first message at ${width}`);
      const paged = await scrollToFirst(cdp);
      const atFirst = await read(cdp);

      step(`reload and open again at ${width}`);
      const reopened = await openChat(cdp, boardUrl);
      widths.push({
        width,
        firstOpen: { ids: opened.ids, history: opened.history, scrollable: opened.scrollable },
        markdown,
        liveWithin1s: live,
        pages: paged.pages,
        anchorDrift: paged.anchorDrift,
        atFirst: { ids: atFirst.ids, history: atFirst.history },
        reloaded: { ids: reopened.ids, texts: reopened.texts.slice(-3) },
        elsewhere,
      });
      cdp.close();
    }

    const run: HistoryRun = { widths };
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
