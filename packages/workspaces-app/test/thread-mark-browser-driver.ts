#!/usr/bin/env bun
/**
 * An agent's mark reaching a doc's comment card on an already-open page, in
 * headless Chromium against a real server and the real doc bundle.
 *
 * Two pages hold one doc open, at 1180x820 (the card is a margin balloon)
 * and at 430x932 (the card sits inline in the doc). The 430 page asks for
 * reduced motion, so the marks' static form is read there. An agent marks
 * the comment working over REST, then done; each page is read until its card
 * wears the mark, with a 1s deadline from the request. Each reading also
 * holds the card's box before and after, and the motion the mark computes.
 *
 * Spawned by `thread-mark-browser.test.ts`, which reads the JSON it prints.
 * `THREAD_MARK_SHOTS=<dir>` also writes a screenshot of each page per mark.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import type { MarkRead, ThreadMarkRun } from './thread-mark-browser-reading.ts';

const PHRASE = 'the Saltmarsh slipway opens in spring';
const DOC = [
  '# Harborlight ferry plan',
  'The Riverbend crossing carries commuters at dawn and freight at noon.',
  `We expect ${PHRASE}, after the tide survey.`,
  'The berth design is signed off by the harbour board.',
].join('\n\n');
const AGENT = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
/** The bar the owner set: every surface shows a change within 1s. */
const DEADLINE_MS = 1000;

const step = (what: string): void => {
  process.stderr.write(`[thread-mark-driver] ${what}\n`);
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
    await sleep(25);
  }
  throw new Error(`never happened: ${what}`);
}

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

/** The card's glyph, the mark it wears, its motion, and the card's box. */
const READ = (sel: string) => `(() => {
  const card = document.querySelector(${JSON.stringify(sel)});
  if (!card) return null;
  const glyph = card.querySelector('.thread-glyph');
  const dots = glyph ? [...glyph.querySelectorAll('.cw-breathe')] : [];
  const check = glyph ? glyph.querySelector('path.cw-check') : null;
  const r = card.getBoundingClientRect();
  const g = glyph ? glyph.getBoundingClientRect() : null;
  const cs = (el) => (el ? getComputedStyle(el) : null);
  return {
    mark: glyph ? glyph.getAttribute('data-mark') : null,
    dots: dots.length,
    dotAnimation: dots.map((d) => cs(d).animationName),
    dotOpacity: dots.map((d) => Number(cs(d).opacity)),
    check: !!check,
    checkAnimation: check ? cs(check).animationName : null,
    glyphBackground: glyph ? cs(glyph).backgroundColor : null,
    card: [r.left, r.top, r.width, r.height].map(Math.round),
    glyph: g ? [g.left, g.top, g.width, g.height].map(Math.round) : null,
  };
})()`;

interface Page {
  name: string;
  cdp: Cdp;
  read: () => Promise<MarkRead | null>;
}

async function openPage(url: string, width: number, height: number): Promise<Page> {
  const touch = width <= 1100;
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile),
    STARTUP_TIMEOUT_MS,
    `thread-mark-${width}-${process.pid}`,
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
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
  }
  // A returning reader: a first arrival gets the name prompt over the doc.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  const sel = touch ? '#editor .cw-inline-card' : '.markup-margin .thread';
  await until(`the comment card at ${width}`, async () =>
    (await cdp.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`)) ? true : null,
  );
  return {
    name: String(width),
    cdp,
    read: async () => (await cdp.evaluate(READ(sel))) as MarkRead | null,
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'thread-mark-'));
  const shots = process.env.THREAD_MARK_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let handle: ServerHandle | undefined;
  try {
    step('build the widget and the doc bundle');
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);
    handle = createServer({
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
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author: AGENT })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const file = join(dir, 'ferry-plan.md');
    writeFileSync(file, DOC);
    const docId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'ferry-plan',
          type: 'markdown',
          sourceUrl: file,
        })
      ).docId,
    );
    await fetch(`${base}/workspaces/${ws}/docs/${docId}`);
    const ydoc = await until('the doc in memory', () => server.docStore.get(docId)?.ydoc ?? null);
    // One comment, anchored exactly as the editor anchors one.
    const walk = prose.walkProse(prose.getProseFragment(ydoc));
    const at = walk.plainText.indexOf(PHRASE);
    const seg = walk.segments.find((g) => at >= g.docOffset && at < g.docOffset + g.length);
    if (!seg) throw new Error('no text segment holds the phrase');
    const rel = (i: number) =>
      Array.from(
        Y.encodeRelativePosition(
          Y.createRelativePositionFromTypeIndex(seg.node, i - seg.docOffset),
        ),
      );
    const made = await post(`/workspaces/${ws}/docs/${docId}/threads`, {
      author: { id: 'known-alice', name: 'Alice', color: '#3366cc' },
      text: 'Can we say which month?',
      anchor: {
        kind: 'text-range',
        startRel: rel(at),
        endRel: rel(at + PHRASE.length),
        snippet: { text: PHRASE },
      },
    });
    const threadId =
      (made.thread as { id?: string } | undefined)?.id ?? (made.id as string | undefined);
    if (!threadId) throw new Error(`no thread id: ${JSON.stringify(made)}`);

    step('open the doc at 1180x820 and at 430x932 (reduced motion)');
    const url = `${base}/workspaces/${ws}/docs/${docId}`;
    const pages = [await openPage(url, 1180, 820), await openPage(url, 430, 932)];
    const run: ThreadMarkRun = { pages: {} };
    for (const p of pages) {
      run.pages[p.name] = { before: await p.read(), working: null, done: null };
    }

    for (const state of ['working', 'done'] as const) {
      step(`the agent marks the comment ${state}`);
      const asked = Date.now();
      await post(`/workspaces/${ws}/docs/${docId}/threads/${threadId}/progress`, {
        author: AGENT,
        state,
      });
      const pending = new Set(pages);
      const wears = (r: MarkRead | null) =>
        !!r && r.mark === state && (state === 'working' ? r.dots === 3 : r.check);
      while (pending.size > 0 && Date.now() - asked < DEADLINE_MS) {
        for (const p of [...pending]) {
          const r = await p.read();
          if (wears(r)) pending.delete(p);
        }
        if (pending.size > 0) await sleep(25);
      }
      for (const p of pages) {
        const read = await p.read();
        const entry = run.pages[p.name];
        if (entry) entry[state] = { inTime: !pending.has(p), read };
        if (shots) {
          const png = (await p.cdp.send('Page.captureScreenshot', { format: 'png' })) as {
            data: string;
          };
          writeFileSync(
            join(shots, `mark-${state}-${p.name}.png`),
            Buffer.from(png.data, 'base64'),
          );
        }
      }
    }
    for (const p of pages) p.cdp.close();
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
