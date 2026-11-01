#!/usr/bin/env bun
/**
 * Tapping a link in the lead's reply, in headless Chromium against a real
 * server and the real bundles, on a board's Home at 1180x820 and 430x932.
 *
 * The chat holds a spoken question and the lead's answer to it (drawn as a
 * voice bubble whose words open on a tap) and a typed reply; each reply
 * carries an absolute link to a doc on this server, written as a markdown
 * bullet, and a root-relative one. Each link is pressed, and while the press
 * is held the chat redraws — the lead's session takes a question still on its
 * way, as happens throughout a conversation — and then released. The driver
 * records where the tap went: a new tab's URL, or the page's own.
 *
 * The redraw is the point. While voice is on the chat redraws on every word
 * the listener hears, and a list rebuilt under a press loses the tap: Chromium
 * sends the click to what the press and release share, not to the link, and
 * iOS Safari drops it.
 *
 * Spawned by `lead-chat-links-browser.test.ts`, which reads the JSON it
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
import { LeadChatLog } from '../../server/src/lead-chat/log.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { agentStream } from '../../server/test/agent-voice-stream.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

/** One tap on one link: where the reader ended up. */
export interface LinkTap {
  /** Which message and which link: `voice-absolute`, `typed-relative`, … */
  name: string;
  /** The link's href as drawn, or null when the reply drew no link. */
  href: string | null;
  /** URLs of the tabs the tap opened. */
  opened: string[];
  /** The board tab's URL after the tap. */
  pageUrl: string;
}

export interface LinksWidthRun {
  width: number;
  /** The doc URL each tap should reach. */
  docPath: string;
  taps: LinkTap[];
}

export interface LinksRun {
  widths: LinksWidthRun[];
}

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-links] ${what}\n`);
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

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

interface Opened {
  cdp: Cdp;
  port: number;
}

async function openBrowser(width: number, height: number): Promise<Opened> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile, ['--mute-audio']),
    STARTUP_TIMEOUT_MS,
    `lead-chat-links-${width}-${process.pid}`,
    (started) => {
      browsers.push(started);
    },
  );
  const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const mobile = width <= 1100;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
  });
  return { cdp, port: b.port };
}

/** Every page tab the browser holds, by URL. */
async function tabs(port: number): Promise<Array<{ id: string; url: string }>> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = (await res.json()) as Array<{ id: string; type: string; url: string }>;
  return list.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url }));
}

const BUTTON = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const r = btn ? btn.getBoundingClientRect() : null;
  return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
})()`;

/** The centre of an element inside the chat's shadow root, scrolled into
 *  view first, or null when it is not drawn. */
const centreOf = (selector: string): string => `(() => {
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const pane = sr && sr.querySelector('.lc-pane');
  if (!pane || pane.hidden || pane.getAnimations().length > 0) return null;
  const el = sr.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  if (r.width === 0) return null;
  return { x: r.left + Math.min(r.width / 2, 12), y: r.top + r.height / 2, href: el.getAttribute('href') };
})()`;

type Mouse = 'mousePressed' | 'mouseReleased';
const mouse = (cdp: Cdp, type: Mouse, x: number, y: number) =>
  cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });

async function tap(cdp: Cdp, x: number, y: number): Promise<void> {
  await mouse(cdp, 'mousePressed', x, y);
  await mouse(cdp, 'mouseReleased', x, y);
}

/** The state line a person's message wears, or null before it is drawn. */
const stateOf = (id: string): string => `(() => {
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const s = sr && sr.querySelector('.lc-msg[data-message-id=${JSON.stringify(id)}] .lc-state');
  return s ? s.dataset.s : null;
})()`;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-links-'));
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
    const stream = lead;

    const docPath = `/workspaces/${ws}/docs/d-riverbend`;
    const reply = (label: string): string =>
      [
        `Here is the ${label} summary.`,
        '',
        `- [What We Know](${base}${docPath}): the research summary`,
        `- [Same doc, relative](${docPath}): the same page`,
      ].join('\n');
    const log = new LeadChatLog(dataDir);
    const t0 = Date.now() - 10 * 60_000;
    const leadAuthor = { id: LEAD.agentId, name: LEAD.agentName };
    log.append(ws, {
      id: 'asked',
      role: 'person',
      author: ALICE,
      text: 'Where is the Saltmarsh research?',
      ts: t0,
      state: 'answered',
      via: 'voice',
    });
    log.append(ws, {
      id: 'voice',
      role: 'agent',
      author: leadAuthor,
      text: reply('spoken'),
      ts: t0 + 1000,
      replyTo: 'asked',
    });
    log.append(ws, {
      id: 'typed-ask',
      role: 'person',
      author: ALICE,
      text: 'And in writing?',
      ts: t0 + 2000,
      state: 'answered',
      via: 'chat',
    });
    log.append(ws, {
      id: 'typed',
      role: 'agent',
      author: leadAuthor,
      text: reply('typed'),
      ts: t0 + 3000,
      replyTo: 'typed-ask',
    });

    /** A question typed to the lead, still on its way: the lead's session
     *  has not taken it, so taking it later redraws the chat. */
    const ask = async (text: string): Promise<{ id: string; queueId: string }> => {
      const r = await fetch(`${base}/workspaces/${ws}/lead-chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, author: ALICE }),
      });
      if (!r.ok) throw new Error(`/lead-chat: ${r.status} ${await r.text()}`);
      const id = ((await r.json()) as { message: { id: string } }).message.id;
      const frame = await until('the question to reach the lead', () => {
        return stream.voice.find((f) => f.transcript === text) ?? null;
      });
      if (!frame.queueId) throw new Error('the question carried no queue id');
      return { id, queueId: frame.queueId };
    };

    const homeUrl = `${base}/workspaces/${ws}/home`;
    const widths: LinksWidthRun[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      const { cdp, port } = await openBrowser(width, height);
      const taps: LinkTap[] = [];
      for (const [msg, which, nth] of [
        ['voice', 'absolute', 1],
        ['voice', 'relative', 2],
        ['typed', 'absolute', 1],
        ['typed', 'relative', 2],
      ] as const) {
        const name = `${msg}-${which}`;
        step(`${name} at ${width}`);
        const asked = await ask(`Which doc for ${name} at ${width}?`);
        const loaded = cdp.once('Page.loadEventFired');
        await cdp.send('Page.navigate', { url: homeUrl });
        await loaded;
        const btn = await until('the agent button', async () => {
          return (await cdp.evaluate(BUTTON)) as { x: number; y: number } | null;
        });
        await tap(cdp, btn.x, btn.y);
        if (msg === 'voice') {
          const words = await until('the voice bubble', async () => {
            return (await cdp.evaluate(
              centreOf('.lc-voice[data-message-id="voice"] .lc-voice-btn'),
            )) as { x: number; y: number } | null;
          });
          await tap(cdp, words.x, words.y);
        }
        const body =
          msg === 'voice'
            ? '.lc-voice[data-message-id="voice"] .lc-voice-text'
            : '.lc-msg[data-message-id="typed"] .lc-md';
        const link = await until(`the ${name} link`, async () => {
          return (await cdp.evaluate(centreOf(`${body} li:nth-of-type(${nth}) a`))) as {
            x: number;
            y: number;
            href: string | null;
          } | null;
        }).catch(() => null);
        if (!link) {
          taps.push({ name, href: null, opened: [], pageUrl: homeUrl });
          continue;
        }
        const before = new Set((await tabs(port)).map((t) => t.id));
        // The finger goes down on the link; while it is down the lead's
        // session takes the question, which redraws the chat; then it lifts.
        await mouse(cdp, 'mousePressed', link.x, link.y);
        const acked = await fetch(`${base}/workspaces/${ws}/voice-queue/${asked.queueId}/ack`, {
          method: 'POST',
        });
        if (!acked.ok) throw new Error(`ack: ${acked.status}`);
        await until('the chat to redraw with the question received', async () => {
          return (await cdp.evaluate(stateOf(asked.id))) === 'received' ? true : null;
        });
        await mouse(cdp, 'mouseReleased', link.x, link.y);
        // A tap that goes somewhere goes within a second or two; one that
        // does not leaves both the tabs and the page where they were.
        const landed = await until(
          'the tap to go somewhere',
          async () => {
            const now = await tabs(port);
            const fresh = now.filter((t) => !before.has(t.id) && t.url !== 'about:blank');
            const here = String(await cdp.evaluate('location.href').catch(() => ''));
            if (fresh.length > 0) return { opened: fresh.map((t) => t.url), pageUrl: here };
            if (here.includes('/docs/')) return { opened: [], pageUrl: here };
            return null;
          },
          4000,
        ).catch(async () => ({
          opened: [],
          pageUrl: String(await cdp.evaluate('location.href').catch(() => '')),
        }));
        for (const t of await tabs(port)) {
          if (!before.has(t.id)) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
        }
        taps.push({ name, href: link.href, ...landed });
      }
      widths.push({ width, docPath, taps });
      cdp.close();
    }
    const run: LinksRun = { widths };
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
