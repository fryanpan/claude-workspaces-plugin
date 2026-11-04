#!/usr/bin/env bun
/**
 * What a link to a board doc in the lead's reply reads as, and where a click
 * on it goes, in headless Chromium against a real server and the real
 * bundles, on a board's Home at 1180x820 and 430x932.
 *
 * The lead's reply links one doc five ways: a bare absolute URL, a bare
 * root-relative path, a markdown link whose label is the URL itself, one
 * whose label is the doc's id, and one with words of the author's own. The
 * driver records each link's text once the chat has settled, then clicks a
 * link plainly and with the platform's new-tab modifier (Cmd on a Mac, Ctrl
 * elsewhere), and records which tab each click reached.
 *
 * Spawned by `lead-chat-link-names-browser.test.ts`, which reads the JSON it
 * prints.
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
import { LeadChatLog } from '../../server/src/lead-chat/log.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };
const DOC_ID = 'd-riverbend';
const DOC_TITLE = 'What We Know';
const OWN_LABEL = 'the research notes';

/** Where one click went. */
export interface ClickRun {
  /** The board tab's URL after the click. */
  pageUrl: string;
  /** URLs of the tabs the click opened. */
  opened: string[];
}

export interface NamesWidthRun {
  width: number;
  /** The doc's path, which every link names. */
  docPath: string;
  /** Each link's text, in the order the reply writes them. */
  texts: string[];
  /** Each link's `target` attribute, or null when it has none. */
  targets: Array<string | null>;
  plain: ClickRun;
  newTab: ClickRun;
}

export interface NamesRun {
  widths: NamesWidthRun[];
}

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-link-names] ${what}\n`);
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

async function openBrowser(width: number, height: number): Promise<{ cdp: Cdp; port: number }> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile, ['--mute-audio']),
    STARTUP_TIMEOUT_MS,
    `lead-chat-link-names-${width}-${process.pid}`,
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
  return { cdp, port: b.port };
}

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

const LINKS = `[...(document.querySelector('[data-lead-chat="layer"]')?.shadowRoot
  ?.querySelectorAll('.lc-msg[data-message-id="reply"] .lc-md li a') ?? [])]`;

/** The reply's links as drawn, once none waits on a title. */
const READ_LINKS = `(() => {
  const links = ${LINKS};
  if (links.length < 5 || links.some((a) => a.hasAttribute('data-ws-pending'))) return null;
  return { texts: links.map((a) => a.textContent), targets: links.map((a) => a.getAttribute('target')) };
})()`;

/** The centre of the first link, scrolled into view, or null before it is. */
const FIRST_LINK = `(() => {
  const pane = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot?.querySelector('.lc-pane');
  if (!pane || pane.hidden || pane.getAnimations().length > 0) return null;
  const a = ${LINKS}[0];
  if (!a) return null;
  a.scrollIntoView({ block: 'center' });
  // The first line box: a URL that wraps has a gap between its lines, and
  // the centre of the whole box can fall in it.
  const r = a.getClientRects()[0];
  return r && r.width > 0 ? { x: r.left + Math.min(r.width / 2, 12), y: r.top + r.height / 2 } : null;
})()`;

/** CDP's modifier bits: Ctrl 2, Meta 4. A Mac opens a new tab on Cmd. */
const NEW_TAB_MODIFIER = process.platform === 'darwin' ? 4 : 2;

async function click(cdp: Cdp, x: number, y: number, modifiers: number): Promise<void> {
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

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-link-names-'));
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
    const post = async (path: string, body: unknown): Promise<unknown> => {
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return r.json();
    };
    const made = (await post('/workspaces', { name: 'Harborlight', author: ALICE })) as {
      workspace: { id: string };
    };
    const ws = made.workspace.id;
    server.tasks.attachAgent(ws, { ...LEAD, runtime: 'claude-code-local' });
    server.tasks.setLeadAgent(ws, LEAD.agentId, { actor: ALICE });
    const mdPath = join(dir, 'what-we-know.md');
    writeFileSync(mdPath, `# ${DOC_TITLE}\n\nThe research summary.\n`);
    await post(`/workspaces/${ws}/docs`, {
      docId: DOC_ID,
      type: 'markdown',
      sourceUrl: mdPath,
      title: DOC_TITLE,
    });
    await post(`/workspaces/${ws}/docs:attach`, { docId: DOC_ID });

    const docPath = `/workspaces/${ws}/docs/${DOC_ID}`;
    const abs = `${base}${docPath}`;
    const log = new LeadChatLog(dataDir);
    const t0 = Date.now() - 10 * 60_000;
    log.append(ws, {
      id: 'ask',
      role: 'person',
      author: ALICE,
      text: 'Where is the Saltmarsh research?',
      ts: t0,
      state: 'answered',
      via: 'chat',
    });
    log.append(ws, {
      id: 'reply',
      role: 'agent',
      author: { id: LEAD.agentId, name: LEAD.agentName },
      text: [
        'The research, five ways:',
        '',
        `- ${abs}`,
        `- ${docPath}`,
        `- [${abs}](${abs})`,
        `- [${DOC_ID}](${docPath})`,
        `- [${OWN_LABEL}](${docPath})`,
      ].join('\n'),
      ts: t0 + 1000,
      replyTo: 'ask',
    });

    const homeUrl = `${base}/workspaces/${ws}/home`;
    const openChat = async (cdp: Cdp): Promise<void> => {
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: homeUrl });
      await loaded;
      const btn = await until('the agent button', async () => {
        return (await cdp.evaluate(BUTTON)) as { x: number; y: number } | null;
      });
      await click(cdp, btn.x, btn.y, 0);
    };
    const clickFirst = async (cdp: Cdp, port: number, modifiers: number): Promise<ClickRun> => {
      await openChat(cdp);
      const at = await until('the first link', async () => {
        return (await cdp.evaluate(FIRST_LINK)) as { x: number; y: number } | null;
      });
      const before = new Set((await tabs(port)).map((t) => t.id));
      await click(cdp, at.x, at.y, modifiers);
      const landed = await until(
        'the click to go somewhere',
        async () => {
          const fresh = (await tabs(port)).filter(
            (t) => !before.has(t.id) && t.url !== 'about:blank',
          );
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
      return landed;
    };

    const widths: NamesWidthRun[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      step(`names at ${width}`);
      const { cdp, port } = await openBrowser(width, height);
      await openChat(cdp);
      const drawn = await until(
        'the reply’s links with every title in',
        async () => {
          return (await cdp.evaluate(READ_LINKS)) as {
            texts: string[];
            targets: Array<string | null>;
          } | null;
        },
        8000,
      ).catch(async () => {
        // Still pending: record what shows, so the test names the raw text.
        return (await cdp.evaluate(`(() => {
          const links = ${LINKS};
          return { texts: links.map((a) => a.textContent), targets: links.map((a) => a.getAttribute('target')) };
        })()`)) as { texts: string[]; targets: Array<string | null> };
      });
      step(`clicks at ${width}`);
      const plain = await clickFirst(cdp, port, 0);
      const newTab = await clickFirst(cdp, port, NEW_TAB_MODIFIER);
      widths.push({ width, docPath, ...drawn, plain, newTab });
      cdp.close();
    }
    process.stdout.write(`\n${JSON.stringify({ widths } satisfies NamesRun)}\n`);
  } finally {
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
