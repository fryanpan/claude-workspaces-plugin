#!/usr/bin/env bun
/**
 * Typing a reply on a doc thread while an agent replies, in headless Chromium
 * against a real server and the real doc bundle.
 *
 * The reader opens a thread at 1180x820 and at 430x932, presses keys one at a
 * time into its reply box, and an agent posts through the same REST route
 * `post_reply` calls while keys are still going in. The reader finishes the
 * sentence and presses Enter. The server's own list of the thread's comments
 * is the reading: it is what the reader saw posted.
 *
 * Spawned by `reply-while-typing-browser.test.ts`, which reads the JSON it
 * prints. `REPLY_TYPING_APP=<dir>` builds the doc bundle from another
 * checkout's `packages/workspaces-app`, which is how the base commit runs.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
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
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';
import { ABOVE, HELPERS, PLAN, TARGET, scrollAnchorTo } from './comment-focus-remote-edit-page.ts';
import type {
  ReplyDelivery,
  ReplyTypingRun,
  ReplyTypingScenario,
} from './reply-while-typing-reading.ts';

/** The reported sentence. */
const SENTENCE = 'The survey goes first. And then the tide table decides the slipway.';
/** Where the agent's reply goes out: where the report's comment was cut, or
 *  inside a word. */
const CUT = 'The survey goes first. And then'.length;
const CUT_MID_WORD = 'The survey goes first. And th'.length;
const KEY_GAP_MS = 25;

const AGENT = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
const DELIVERIES: ReplyDelivery[] = [
  'same-thread',
  'mid-word',
  'other-thread',
  'same-thread-ask',
  'burst',
];

const step = (what: string): void => {
  process.stderr.write(`[reply-typing-driver] ${what}\n`);
};

async function until<T>(
  what: string,
  read: () => Promise<T | null> | T | null,
  ms = 30_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

interface Server {
  base: string;
  ws: string;
  post: (path: string, payload: unknown) => Promise<Record<string, unknown>>;
  handle: ServerHandle;
}

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function makeDoc(
  s: Server,
  dir: string,
  name: string,
): Promise<{ docId: string; threads: Record<string, string> }> {
  const file = join(dir, `${name}.md`);
  writeFileSync(file, PLAN);
  const docId = String(
    (await s.post(`/workspaces/${s.ws}/docs`, { docId: name, type: 'markdown', sourceUrl: file }))
      .docId,
  );
  await fetch(`${s.base}/workspaces/${s.ws}/docs/${docId}`);
  const ydoc = await until('the doc in memory', () => s.handle.docStore.get(docId)?.ydoc ?? null);
  const threads: Record<string, string> = {};
  for (const needle of [ABOVE, TARGET]) {
    const walk = prose.walkProse(prose.getProseFragment(ydoc));
    const at = walk.plainText.indexOf(needle);
    const seg = walk.segments.find((g) => at >= g.docOffset && at < g.docOffset + g.length);
    if (!seg) throw new Error(`no text segment holds "${needle}"`);
    const rel = (i: number) =>
      Array.from(
        Y.encodeRelativePosition(
          Y.createRelativePositionFromTypeIndex(seg.node, i - seg.docOffset),
        ),
      );
    const made = await s.post(`/workspaces/${s.ws}/docs/${docId}/threads`, {
      author: { id: 'known-alice', name: 'Alice', color: '#3366cc' },
      text: `Who signs off the ${needle}?`,
      anchor: {
        kind: 'text-range',
        startRel: rel(at),
        endRel: rel(at + needle.length),
        snippet: { text: needle },
      },
    });
    const id = (made.thread as { id?: string } | undefined)?.id ?? (made.id as string | undefined);
    if (!id) throw new Error(`no thread id: ${JSON.stringify(made)}`);
    threads[needle] = id;
  }
  return { docId, threads };
}

interface Page {
  cdp: Cdp;
  tap: (x: number, y: number) => Promise<void>;
  press: (ch: string) => Promise<void>;
  enter: () => Promise<void>;
}

async function openPage(url: string, width: number, height: number): Promise<Page> {
  const touch = width <= 1100;
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile),
    STARTUP_TIMEOUT_MS,
    `reply-typing-${width}-${process.pid}`,
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
    mobile: touch,
  });
  if (touch) {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  // Every reply the page sends, read off the request. The server's list is
  // the reading wherever it can be: an answer needs a signed-in person, so
  // this fixture's answer is sent and refused, and the send is what counts.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Bob'); } catch {}
      window.__sent = [];
      const realFetch = window.fetch;
      window.fetch = function (url, init) {
        if (/\\/threads\\/[^/]+\\/(comments|answer)$/.test(String(url)) && init && init.body) {
          window.__sent.push(JSON.parse(init.body).text);
        }
        return realFetch.apply(this, arguments);
      };`,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  const cardSel = touch ? '#editor .cw-inline-card' : '.markup-margin .thread';
  await until('two comment cards', async () =>
    Number(
      await cdp.evaluate(
        `[...document.querySelectorAll(${JSON.stringify(cardSel)})].filter((c) => c.querySelector('.md-composer-surface .ProseMirror')).length`,
      ),
    ) >= 2
      ? true
      : null,
  );
  await cdp.evaluate(HELPERS('reply', cardSel));
  return {
    cdp,
    tap: async (x, y) => {
      if (touch) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x, y }],
        });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        return;
      }
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      }
    },
    press: async (ch) => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    },
    enter: async () => {
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    },
  };
}

async function focusReplyBox(page: Page): Promise<void> {
  const face = (await page.cdp.evaluate(`(() => {
    const f = __card().querySelector('.face-summary') || __card();
    const b = f.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + Math.min(b.height / 2, 12) };
  })()`)) as { x: number; y: number };
  await page.tap(face.x, face.y);
  await page.cdp.evaluate('__settled()');
  const box = await until('the reply box on screen', async () => {
    const r = (await page.cdp.evaluate(`(() => {
      const box = __box();
      if (!box || !box.getClientRects().length) return null;
      const b = box.getBoundingClientRect();
      return b.height > 0 ? { x: b.left + 20, y: b.top + b.height / 2 } : null;
    })()`)) as { x: number; y: number } | null;
    return r;
  });
  await page.tap(box.x, box.y);
  await until('the reply box holds focus', async () =>
    (await page.cdp.evaluate('__read().focus')) === 'composer' ? true : null,
  );
}

async function scenario(
  s: Server,
  dir: string,
  width: number,
  height: number,
  delivery: ReplyDelivery,
): Promise<ReplyTypingScenario> {
  const name = `ferry-${width}-${delivery}`;
  step(`${width}x${height} ${delivery}`);
  const { docId, threads } = await makeDoc(s, dir, name);
  const target = threads[TARGET] ?? '';
  const other = threads[ABOVE] ?? '';
  const page = await openPage(`${s.base}/workspaces/${s.ws}/docs/${docId}`, width, height);
  await page.cdp.evaluate(scrollAnchorTo(Math.round(height * 0.3)));
  await page.cdp.evaluate('__settled()');
  await focusReplyBox(page);

  const url = `/workspaces/${s.ws}/docs/${docId}/threads`;
  const reply = (id: string, text: string, review?: unknown) =>
    s.post(`${url}/${id}/comments`, { author: AGENT, text, ...(review ? { review } : {}) });
  const deliver = async (): Promise<void> => {
    if (delivery === 'same-thread' || delivery === 'mid-word') {
      await reply(target, 'The Harborlight survey lands today.');
    }
    if (delivery === 'other-thread') await reply(other, 'The Riverbend survey lands today.');
    if (delivery === 'same-thread-ask') {
      await reply(target, 'Which slipway should take the Saltmarsh ferry?', {
        review_type: 'question',
        headline: 'Which slipway takes the Saltmarsh ferry?',
        why: 'The tide table needs an answer before the evening run.',
      });
    }
    if (delivery === 'burst') {
      await reply(target, 'First Harborlight note.');
      await reply(other, 'First Riverbend note.');
      await reply(target, 'Second Harborlight note.');
    }
  };

  const composed = SENTENCE;
  const cut = delivery === 'mid-word' ? CUT_MID_WORD : CUT;
  // The reply goes out while keys are still going in, and is not awaited, so
  // it lands between two keystrokes rather than at a moment the test chose.
  let delivered: Promise<void> | null = null;
  const focusLost: string[] = [];
  for (const [i, ch] of [...composed].entries()) {
    await page.press(ch);
    if (i === cut - 1) delivered = deliver();
    await sleep(KEY_GAP_MS);
    const was = (await page.cdp.evaluate('__read().focus')) as string;
    if (was !== 'composer') focusLost.push(`${i}:${was}`);
  }
  await delivered;
  await page.cdp.evaluate('__settled()');
  const boxBeforeSend = (await page.cdp.evaluate('__read().text')) as string | null;
  await page.enter();
  const sentByPage = async () => (await page.cdp.evaluate('__sent')) as string[];
  // The box emptied or the request went out: the send has happened, or it is
  // not coming. A reader whose keys went nowhere sends nothing at all.
  await until('a send from the page', async () =>
    (await sentByPage()).length > 0 ? true : null,
  ).catch(() => null);
  await page.cdp.evaluate('__settled()');
  const res = await fetch(`${s.base}${url}`);
  const body = (await res.json()) as {
    threads: Array<{ id: string; comments: Array<{ author?: { id?: string }; text: string }> }>;
  };
  const posted = (body.threads.find((t) => t.id === target)?.comments ?? [])
    .filter((c) => c.author?.id !== AGENT.id && c.author?.id !== 'known-alice')
    .map((c) => c.text);
  const sent = await sentByPage();
  const final = (await page.cdp.evaluate('__read().focus')) as string;
  page.cdp.close();
  const b = browsers.pop();
  if (b) await stopBrowser(b.proc, b.profile);
  return { width, height, delivery, composed, boxBeforeSend, sent, posted, focusLost, final };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'reply-typing-'));
  let handle: ServerHandle | undefined;
  try {
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    step('build the doc bundle');
    const appPkg = process.env.REPLY_TYPING_APP ?? join(import.meta.dirname, '..');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(appPkg, 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000, cwd: appPkg },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const base = `http://127.0.0.1:${handle.port}`;
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
      (await post('/workspaces', { name: 'Harborlight', author: AGENT })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const s: Server = { base, ws, post, handle };
    const scenarios: ReplyTypingScenario[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      for (const delivery of DELIVERIES) {
        scenarios.push(await scenario(s, dir, width, height, delivery));
      }
    }
    const run: ReplyTypingRun = { scenarios };
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
