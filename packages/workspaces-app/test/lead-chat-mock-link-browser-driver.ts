#!/usr/bin/env bun
/**
 * Tapping a mockup link in the lead's chat reply while a review item is open
 * on the board's Home, in headless Chromium against a real server and the
 * real bundles, at 1180x820 and 430x932.
 *
 * The 9 Nov report: a root-relative `/workspaces/<w>/mockups/<docId>` link,
 * tapped in the chat on `/workspaces/<w>/home?item=…`, showed "Page not found
 * … Nothing on this board answers to …" for a mockup that `attach_mockup` had
 * made that day under an alias, while a GET of the same path answered 200.
 *
 * The mockup is attached the way `attach_mockup` attaches one — a POST to the
 * board's `docs` collection with `type: 'mockup'` and a caller-chosen name —
 * and the reply links it both by that name and by the id the server minted.
 * For each link the driver records the page the tap reached: its address,
 * its title and whether it is a not-found page.
 *
 * Spawned by `lead-chat-mock-link-browser.test.ts`, which reads the JSON it
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
import { LeadChatLog } from '../../server/src/lead-chat/log.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';

const LEAD = { agentId: 'harborlight-lead', agentName: 'Harborlight Lead' };
const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };
const ALIAS = 'saltmarsh-home-mock';

/** One tap on one link: where the reader ended up. */
export interface MockLinkTap {
  width: number;
  /** `alias` or `minted`: which name of the mock the link used. */
  name: string;
  href: string | null;
  /** The address the page held before the tap: Home with the item open. */
  from: string;
  /** The address, title and not-found verdict of the page the tap reached. */
  pageUrl: string;
  title: string;
  notFound: boolean;
  /** `status url` of the mock's own frame document, or '' for none. */
  frame: string;
}

export interface MockLinkRun {
  /** The board the person reads, whose id every link names. */
  workspaceId: string;
  /** The board the mock is filed on. */
  mockBoard: string;
  mockId: string;
  taps: MockLinkTap[];
}

const step = (what: string): void => {
  process.stderr.write(`[lead-chat-mock-link] ${what}\n`);
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
/** Every document response, frames included, as `status url`. */
const documents: string[] = [];

async function openBrowser(width: number, height: number): Promise<Cdp> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile, ['--mute-audio']),
    STARTUP_TIMEOUT_MS,
    `lead-chat-mock-link-${width}-${process.pid}`,
    (started) => {
      browsers.push(started);
    },
  );
  const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', (p) => {
    const e = p as unknown as { type: string; response: { url: string; status: number } };
    if (e.type === 'Document') documents.push(`${e.response.status} ${e.response.url}`);
  });
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

const BUTTON = `(() => {
  const host = document.querySelector('[data-lead-chat="button"]');
  const btn = host && host.shadowRoot && host.shadowRoot.querySelector('button');
  const r = btn ? btn.getBoundingClientRect() : null;
  return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
})()`;

/** Opens the first review item on Home the way a tap on its row does. */
const OPEN_ITEM = `(() => {
  const row = document.querySelector('#board-home-review button.board-review-row');
  if (!row) return false;
  row.click();
  return true;
})()`;

/** The centre of the nth link in the lead's reply, scrolled into view. */
const linkAt = (nth: number): string => `(() => {
  const sr = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  const pane = sr && sr.querySelector('.lc-pane');
  if (!pane || pane.hidden || pane.getAnimations().length > 0) return null;
  const el = sr.querySelector('.lc-msg[data-message-id="reply"] .lc-md li:nth-of-type(${nth}) a');
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  if (r.width === 0) return null;
  return { x: r.left + Math.min(r.width / 2, 12), y: r.top + r.height / 2, href: el.getAttribute('href') };
})()`;

async function tap(cdp: Cdp, x: number, y: number): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-chat-mock-link-'));
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
    const author = { id: LEAD.agentId, name: LEAD.agentName, kind: 'agent' };
    const { task } = (await post(`/workspaces/${ws}/tasks`, {
      title: 'Saltmarsh home page',
      body: 'Alice can see the tides first so that sailors plan.',
      author,
    })) as { task: { id: string } };
    await post(`/workspaces/${ws}/tasks/${task.id}/review-items`, {
      review: {
        shape: 'decision',
        headline: 'Which Saltmarsh home page layout?',
        detail: 'The mock shows both.',
        options: [
          { id: 'a', label: 'Tides first' },
          { id: 'b', label: 'Map first' },
        ],
      },
      author,
    });

    // `attach_mockup(docId, sourceHtmlPath)` as the MCP tool sends it, from a
    // session whose own board is not the one the person is reading.
    const mockBoard = (
      (await post('/workspaces', { name: 'Riverbend', author: ALICE })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const source = join(dir, 'saltmarsh-home.html');
    writeFileSync(
      source,
      '<!doctype html><html><head><title>Saltmarsh</title></head><body><h1>Tides</h1></body></html>',
    );
    const attached = (await post(`/workspaces/${mockBoard}/docs`, {
      docId: ALIAS,
      type: 'mockup',
      owner: dir,
      sourceUrl: source,
      title: 'Saltmarsh home mock',
    })) as { docId: string };
    const mockId = attached.docId;

    const log = new LeadChatLog(dataDir);
    const t0 = Date.now() - 10 * 60_000;
    log.append(ws, {
      id: 'ask',
      role: 'person',
      author: ALICE,
      text: 'Where is the mock?',
      ts: t0,
      state: 'answered',
      via: 'chat',
    });
    log.append(ws, {
      id: 'reply',
      role: 'agent',
      author: { id: LEAD.agentId, name: LEAD.agentName },
      text: [
        'The mock is up.',
        '',
        `- [By its name](/workspaces/${ws}/mockups/${ALIAS})`,
        `- [By its id](/workspaces/${ws}/mockups/${mockId})`,
      ].join('\n'),
      ts: t0 + 1000,
      replyTo: 'ask',
    });

    const homeUrl = `${base}/workspaces/${ws}/home`;
    const taps: MockLinkTap[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      const cdp = await openBrowser(width, height);
      for (const [name, nth] of [
        ['alias', 1],
        ['minted', 2],
      ] as const) {
        step(`${name} at ${width}`);
        const loaded = cdp.once('Page.loadEventFired');
        await cdp.send('Page.navigate', { url: homeUrl });
        await loaded;
        await until('a review row on Home', async () =>
          (await cdp.evaluate(OPEN_ITEM)) === true ? true : null,
        );
        const from = await until('the item in the address', async () => {
          const href = String(await cdp.evaluate('location.href'));
          return href.includes('item=') ? href : null;
        });
        const btn = await until(
          'the agent button',
          async () => (await cdp.evaluate(BUTTON)) as { x: number; y: number } | null,
        );
        await tap(cdp, btn.x, btn.y);
        const link = await until(
          `the ${name} link`,
          async () =>
            (await cdp.evaluate(linkAt(nth))) as { x: number; y: number; href: string } | null,
        );
        documents.length = 0;
        const left = cdp.once('Page.loadEventFired');
        await tap(cdp, link.x, link.y);
        await Promise.race([left, sleep(8000)]);
        const page = await until('the page the tap reached', async () => {
          const r = (await cdp.evaluate(`(() => ({
            url: location.href,
            title: document.title,
            notFound: /Nothing on this board answers|Page not found|Doc not found|Mockup not found/.test(document.body ? document.body.innerText : ''),
          }))()`)) as { url: string; title: string; notFound: boolean } | null;
          return r && !r.url.includes('/home') ? r : null;
        });
        // The mock itself is a frame inside the page; a page that opened
        // with a dead frame is still a dead link.
        const frame = await until(
          'the mock frame',
          () => documents.find((d) => d.includes('cw-frame=1')) ?? (page.notFound ? '' : null),
        ).catch(() => '');
        taps.push({
          width,
          name,
          href: link.href,
          from,
          pageUrl: page.url,
          title: page.title,
          notFound: page.notFound,
          frame,
        });
      }
      cdp.close();
    }
    const run: MockLinkRun = { workspaceId: ws, mockBoard, mockId, taps };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
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
