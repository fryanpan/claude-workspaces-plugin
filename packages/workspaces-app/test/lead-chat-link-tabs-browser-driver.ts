#!/usr/bin/env bun
/**
 * Links in the lead's chat, followed with voice on, in headless Chromium
 * against a real server and the real bundles, at 1180x820 with a mouse and
 * 430x932 with touch.
 *
 * Three reports from the owner on 9 Nov, each one case here:
 *  - a mock link from an agent's closing message opened "Page not found …
 *    Nothing on this board answers to <id>". The closing message reaches the
 *    chat through the Stop hook's reducer (`fullNote`), which cut a
 *    root-relative path to its last segment, so the panel drew `[mock](<id>)`.
 *    The reply here goes through the same reducer.
 *  - a board link opened a new tab and left the voice chat behind. A board
 *    link must open in this tab with voice still listening; Cmd- or
 *    Ctrl-click still opens a new tab; a link off the app opens a new tab
 *    and this tab keeps listening.
 *  - on a phone a link needed a long press. A short tap must follow it.
 *
 * No real device and no billed engine: Chrome's fake microphone, muted
 * output, a listener that only counts the frames it is sent.
 *
 * Spawned by `lead-chat-link-tabs-browser.test.ts`, which reads the JSON it
 * prints on its last line.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { fullNote } from '../../plugin/hooks/lib/note-redact.ts';
import { LeadChatLog } from '../../server/src/lead-chat/log.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import type { SpokenVoice } from '../../server/src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../../server/src/transcribe.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };

export type LinkName = 'mock' | 'doc' | 'external';
export type Gesture = 'tap' | 'touch' | 'new-tab-click';

export interface LinkTabCase {
  width: number;
  link: LinkName;
  gesture: Gesture;
  /** The link's href as drawn, and its `target` attribute. */
  href: string;
  target: string | null;
  /** The tabs the gesture opened, by URL. */
  opened: string[];
  /** This tab's address after the gesture. */
  pageUrl: string;
  /** This tab shows a not-found page. */
  notFound: boolean;
  /** The agent button listens on this tab after the gesture. */
  listening: boolean;
}

export interface LinkTabsRun {
  workspaceId: string;
  docPath: string;
  mockPath: string;
  externalUrl: string;
  cases: LinkTabCase[];
}

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-link-tabs] ${what}\n`);
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

const SETTLED_PANE = `(() => {
  const pane = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot?.querySelector('.lc-pane');
  return !!pane && !pane.hidden && pane.getBoundingClientRect().width > 0 && pane.getAnimations().length === 0;
})()`;

const centreOf = (sel: string): string => `(() => {
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const el = sr && sr.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return r.width > 0 ? { x: r.left + Math.min(r.width / 2, 12), y: r.top + r.height / 2 } : null;
})()`;

/** The nth link of a reply, where it is, and what it says it opens. */
const linkAt = (message: string, nth: number): string => `(() => {
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const el = sr && sr.querySelector('.lc-msg[data-message-id="${message}"] .lc-md li:nth-of-type(${nth}) a');
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  if (r.width === 0) return null;
  return {
    x: r.left + Math.min(r.width / 2, 12),
    y: r.top + r.height / 2,
    href: el.href,
    target: el.getAttribute('target'),
  };
})()`;

const PAGE = `(() => ({
  url: location.href,
  notFound: /Nothing on this board answers|Page not found|Doc not found|Mockup not found|Workspace not found/.test(document.body ? document.body.innerText : ''),
}))()`;

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

interface Opened {
  cdp: Cdp;
  port: number;
}

async function openBrowser(width: number, height: number): Promise<Opened> {
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
    `lead-chat-link-tabs-${width}-${process.pid}`,
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
  if (mobile) {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  // A returning reader on a Voice first device: the first tap listens.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); localStorage.setItem('cw.lead-chat.mode', 'voice'); } catch {}`,
  });
  return { cdp, port: b.port };
}

/** Every page tab the browser holds. */
async function tabs(port: number): Promise<Array<{ id: string; url: string }>> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = (await res.json()) as Array<{ id: string; type: string; url: string }>;
  return list.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url }));
}

/** A mouse click, with the platform's new-tab modifier when asked. */
async function click(cdp: Cdp, x: number, y: number, newTab = false): Promise<void> {
  // CDP's modifier bits: 2 is Ctrl, 4 is Meta (Cmd).
  const modifiers = newTab ? (process.platform === 'darwin' ? 4 : 2) : 0;
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: 1,
      modifiers,
    });
  }
}

/** A short tap: a finger down and up at once, no hold. */
async function touch(cdp: Cdp, x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-link-tabs-'));
  let handle: ServerHandle | undefined;
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
        return { send: () => {}, close: async () => {} };
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

    const plan = join(dir, 'riverbend-summary.md');
    writeFileSync(plan, '# Riverbend summary\n');
    const docId = String(
      (
        (await post(`/workspaces/${ws}/docs`, {
          docId: 'riverbend-summary',
          type: 'markdown',
          title: 'Riverbend summary',
          sourceUrl: plan,
        })) as { docId: string }
      ).docId,
    );
    // `attach_mockup(docId, sourceHtmlPath)`, as the MCP tool sends it.
    const source = join(dir, 'saltmarsh-home.html');
    writeFileSync(source, '<!doctype html><html><body><h1>Saltmarsh tides</h1></body></html>');
    const mockId = String(
      (
        (await post(`/workspaces/${ws}/docs`, {
          docId: 'saltmarsh-home-mock',
          type: 'mockup',
          sourceUrl: source,
          title: 'Saltmarsh home mock',
        })) as { docId: string }
      ).docId,
    );
    const docPath = `/workspaces/${ws}/docs/${docId}`;
    const mockPath = `/workspaces/${ws}/mockups/${mockId}`;
    // Another origin on this machine: off the app, and nothing leaves the box.
    const externalUrl = `http://localhost:${server.port}/healthz`;

    const log = new LeadChatLog(dataDir);
    const t0 = Date.now() - 10 * 60_000;
    const leadAuthor = { id: LEAD.agentId, name: LEAD.agentName };
    log.append(ws, {
      id: 'ask',
      role: 'person',
      author: ALICE,
      text: 'Where are the mock and the summary?',
      ts: t0,
      state: 'answered',
      via: 'chat',
    });
    // The closing message as the agent wrote it, through the Stop hook's
    // reducer, as it reaches the chat.
    log.append(ws, {
      id: 'reply',
      role: 'agent',
      author: leadAuthor,
      text: fullNote(
        ['Both are up.', '', `- [the mock](${mockPath})`, `- [the summary](${docPath})`].join('\n'),
      ),
      ts: t0 + 1000,
      replyTo: 'ask',
    });
    log.append(ws, {
      id: 'ext',
      role: 'agent',
      author: leadAuthor,
      text: ['And the tide service:', '', `- [tides](${externalUrl})`].join('\n'),
      ts: t0 + 2000,
    });

    const homeUrl = `${base}/workspaces/${ws}/home`;
    const cases: LinkTabCase[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      const { cdp, port } = await openBrowser(width, height);
      const phone = width <= 1100;
      const plans: Array<[LinkName, Gesture]> = phone
        ? [
            ['mock', 'touch'],
            ['doc', 'touch'],
            ['external', 'touch'],
          ]
        : [
            ['mock', 'tap'],
            ['doc', 'tap'],
            ['doc', 'new-tab-click'],
            ['external', 'tap'],
          ];
      for (const [link, gesture] of plans) {
        step(`${link} by ${gesture} at ${width}`);
        for (let i = 0; i < 2; i++) {
          if (i === 1) await cdp.evaluate('sessionStorage.clear()');
          const loaded = cdp.once('Page.loadEventFired');
          await cdp.send('Page.navigate', { url: homeUrl });
          await loaded;
        }
        const btn = await until(
          'the agent button',
          async () => (await cdp.evaluate(BUTTON)) as { x: number; y: number } | null,
        );
        // Voice first: the first tap brings the bar out and listens.
        await (phone ? touch(cdp, btn.x, btn.y) : click(cdp, btn.x, btn.y));
        await until('listening', async () => ((await cdp.evaluate(LISTENING)) ? true : null));
        const bar = await until(
          'the bar',
          async () => (await cdp.evaluate(centreOf('.lc-bar'))) as { x: number; y: number } | null,
        );
        await (phone ? touch(cdp, bar.x, bar.y) : click(cdp, bar.x, bar.y));
        await until('the panel open', async () =>
          (await cdp.evaluate(SETTLED_PANE)) ? true : null,
        );
        const [message, nth] =
          link === 'external' ? ['ext', 1] : link === 'mock' ? ['reply', 1] : ['reply', 2];
        const at = await until(
          `the ${link} link`,
          async () =>
            (await cdp.evaluate(linkAt(message, nth))) as {
              x: number;
              y: number;
              href: string;
              target: string | null;
            } | null,
        );
        const before = new Set((await tabs(port)).map((t) => t.id));
        if (gesture === 'touch') await touch(cdp, at.x, at.y);
        else await click(cdp, at.x, at.y, gesture === 'new-tab-click');
        // A gesture that goes somewhere goes within a few seconds: a new tab,
        // or this tab leaving Home.
        await until(
          'the gesture to go somewhere',
          async () => {
            const fresh = (await tabs(port)).filter((t) => !before.has(t.id));
            if (fresh.length > 0) return true;
            const here = String(await cdp.evaluate('location.pathname').catch(() => ''));
            return here.endsWith('/home') ? null : true;
          },
          6000,
        ).catch(() => step(`the ${link} ${gesture} went nowhere`));
        const opened = (await tabs(port)).filter((t) => !before.has(t.id)).map((t) => t.url);
        // This tab, once it has loaded whatever it was going to load.
        const page = await until(
          'this tab settled',
          async () => {
            try {
              const r = (await cdp.evaluate(PAGE)) as { url: string; notFound: boolean };
              return (await cdp.evaluate('document.readyState')) === 'complete' ? r : null;
            } catch {
              return null;
            }
          },
          10_000,
        );
        // Voice on this tab: back on by itself after a same-tab load, or never
        // off when the link went to another tab. A mock page has no agent
        // button to read, so it is read only where one is drawn.
        const listening = page.url.includes('/mockups/')
          ? false
          : await until(
              'listening on this tab',
              async () => ((await cdp.evaluate(LISTENING).catch(() => false)) ? true : null),
              8000,
            ).catch(() => false);
        for (const t of await tabs(port)) {
          if (!before.has(t.id)) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
        }
        cases.push({
          width,
          link,
          gesture,
          href: at.href,
          target: at.target,
          opened,
          pageUrl: page.url,
          notFound: page.notFound,
          listening,
        });
      }
      cdp.close();
    }
    const run: LinkTabsRun = { workspaceId: ws, docPath, mockPath, externalUrl, cases };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
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
