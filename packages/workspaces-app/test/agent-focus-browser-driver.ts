#!/usr/bin/env bun
/**
 * The planning voice's cursor on open doc pages, in headless Chromium against
 * a real server and the real doc bundle.
 *
 * Two pages hold a long plan open, one at 1180x820 and one at 430x932, each
 * scrolled to the top and each reloaded once, so the second load boots from
 * the browser's own copy of the doc (`doc-cache-boot.ts`) the way a reader's
 * does. The wide page's editor holds the caret at the top, as a writer's
 * does. A third client speaks on the spoken-reply socket, and the voice asks
 * about words in the plan's middle, then, after a skip, about the open
 * question at its foot. Each page has to scroll to each and highlight it.
 *
 * Each boundary the focus crosses is read separately, so a failure names its
 * step: the server's own presence state, the decoration on each page, and
 * whether the highlighted words are inside the page's visible area.
 *
 * Spawned by `agent-focus-browser.test.ts`, which reads the JSON it prints.
 * `AGENT_FOCUS_SHOTS=<dir>` also writes a screenshot of each page.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_FOCUS_FIELD } from '@claude-workspaces/core/spoken-reply';
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
import { READER_SYSTEM } from '../../server/src/spoken-reply/interview-reader.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';
import type { AgentFocusRun, FocusStep, FocusView } from './agent-focus-browser-reading.ts';

const FILLER =
  'The Riverbend crossing carries commuters at dawn and freight at noon, and the ' +
  'Saltmarsh tide table decides which of the two slipways can take a loaded ferry.';
const SECTION = (title: string) =>
  `## ${title}\n\n${Array.from({ length: 6 }, () => FILLER).join('\n\n')}\n`;
const QUESTION = 'Who signs off the berth design?';
const COST = 'The Saltmarsh pontoon costs forty thousand.';
const PLAN = [
  '# Harborlight ferry plan\n',
  SECTION('Background'),
  SECTION('Approach'),
  `${SECTION('Costs')}\n${COST}\n`,
  SECTION('Risks'),
  `## Rollout\n\n- ${QUESTION}\n`,
].join('\n');

/** What the voice is told at each pause, and what the model asks back: a
 *  question on the Costs section, then, after a skip, the one at the foot. */
const SAID = ['We open the berth in spring.', 'Skip.'];
const READINGS = [
  { ask: 'Who pays for the pontoon?', heading: 'Costs', quote: 'Saltmarsh pontoon' },
  { ask: QUESTION, heading: 'Rollout', quote: QUESTION },
];

const step = (what: string): void => {
  process.stderr.write(`[agent-focus-driver] ${what}\n`);
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
    await sleep(100);
  }
  throw new Error(`never happened: ${what}`);
}

/** Where the focus is on a page: the highlight, and whether it is in view. */
const VIEW = `(() => {
  const ed = document.querySelector('#editor');
  const hit = document.querySelector('#editor .agent-focus');
  const box = ed ? ed.getBoundingClientRect() : null;
  const r = hit ? hit.getBoundingClientRect() : null;
  const top = Math.max(0, box ? box.top : 0);
  const bottom = Math.min(innerHeight, box ? box.bottom : innerHeight);
  return {
    highlighted: hit ? hit.textContent : null,
    caret: document.querySelector('#editor .agent-focus-name')?.textContent ?? null,
    inView: !!r && r.height > 0 && r.top >= top && r.bottom <= bottom,
    editorScrollTop: ed ? ed.scrollTop : -1,
    windowScrollY: scrollY,
  };
})()`;

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function openPage(
  url: string,
  width: number,
  height: number,
): Promise<{ cdp: Cdp; cached: boolean }> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile),
    STARTUP_TIMEOUT_MS,
    `agent-focus-${width}-${process.pid}`,
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
  // A returning reader: a first arrival gets the name prompt over the doc.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
  });
  const load = async (go: () => Promise<unknown>) => {
    const loaded = cdp.once('Page.loadEventFired');
    await go();
    await loaded;
    await until('the plan on the page', async () =>
      String(
        await cdp.evaluate(`document.querySelector('#editor .ProseMirror')?.textContent`),
      ).includes(QUESTION)
        ? true
        : null,
    );
  };
  await load(() => cdp.send('Page.navigate', { url }));
  // The copy is written once the server's sync lands; the reload boots from it.
  const cached = await until(
    'the copy kept',
    async () =>
      (await cdp.evaluate(`new Promise((r) => {
      const o = indexedDB.open('cw-doc-cache');
      o.onsuccess = () => {
        const d = o.result;
        if (!d.objectStoreNames.contains('docs')) return r(false);
        const g = d.transaction('docs').objectStore('docs').count();
        g.onsuccess = () => r(g.result > 0);
        g.onerror = () => r(false);
      };
      o.onerror = () => r(false);
    })`))
        ? true
        : null,
    8_000,
  ).catch(() => false);
  await load(() => cdp.send('Page.reload', {}));
  return { cdp, cached };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-focus-'));
  const shots = process.env.AGENT_FOCUS_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let handle: ServerHandle | undefined;
  try {
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    step('build the doc bundle');
    const appPkg = join(import.meta.dirname, '..');
    // Its own folder: the build deletes its output first, so a shared one
    // races any other driver building at the same time (scripts/build.ts).
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(appPkg, 'scripts', 'build.ts'), '--outdir', appDist],
      {
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
      spokenReply: {
        listener: { name: 'none', open: async () => ({ send: () => {}, close: async () => {} }) },
        voices: {
          1: { name: 'quiet', speak: async (_t, onAudio) => onAudio(new Uint8Array(480)) },
          2: null,
        },
        gemini: null,
      },
      voiceComplete: async ({ system }) => {
        if (!system.startsWith(READER_SYSTEM)) return '';
        const next = READINGS.shift();
        return JSON.stringify(next ?? { ask: null, why: 'Nothing else is open.' });
      },
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
    const file = join(dir, 'ferry-plan.md');
    writeFileSync(file, PLAN);
    const author = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author })) as { workspace: { id: string } }
    ).workspace.id;
    const docId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'ferry-plan',
          type: 'markdown',
          sourceUrl: file,
        })
      ).docId,
    );
    const url = `${base}/workspaces/${ws}/docs/${docId}`;

    step('open the plan at 1180x820 and 430x932, then reload each from its copy');
    const wide = await openPage(url, 1180, 820);
    const narrow = await openPage(url, 430, 932);
    const pages: Array<[string, Cdp]> = [
      ['1180', wide.cdp],
      ['430', narrow.cdp],
    ];
    const before: Record<string, FocusView> = {};
    for (const [name, cdp] of pages) {
      before[name] = (await cdp.evaluate(VIEW)) as FocusView;
    }

    // A reader with the caret in the doc: the wide page's editor has focus
    // at the top, the way a writer's does after a tap into the text.
    await wide.cdp.evaluate(`(() => {
      const ed = document.querySelector('#editor .ProseMirror');
      ed.focus();
      const r = document.createRange();
      r.setStart(ed.querySelector('h1'), 0);
      r.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    })()`);

    step('a third client speaks at a pause, and the voice asks');
    const voice = new WebSocket(`${base.replace('http', 'ws')}/workspaces/${ws}/voice/converse`);
    const frames: Array<Record<string, unknown>> = [];
    voice.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') frames.push(JSON.parse(ev.data));
    });
    await new Promise<void>((resolve, reject) => {
      voice.addEventListener('open', () => resolve());
      voice.addEventListener('error', () => reject(new Error('converse socket refused')));
    });
    await until('voice ready', () => (frames.some((f) => f.type === 'ready') ? true : null));
    voice.send(
      JSON.stringify({ type: 'start', setup: 1, mode: 'tap', context: { surface: 'doc', docId } }),
    );
    const steps: FocusStep[] = [];
    for (const [i, said] of SAID.entries()) {
      voice.send(JSON.stringify({ type: 'say', text: said }));
      const reply = await until(`reply ${i + 1}`, () =>
        frames.filter((f) => f.type === 'reply').length > i
          ? (frames.filter((f) => f.type === 'reply')[i] ?? null)
          : null,
      );
      const state = server.docStore.get(docId)?.awareness.getLocalState() as Record<
        string,
        unknown
      > | null;
      const serverFocus = (state?.[AGENT_FOCUS_FIELD] ?? null) as { quote?: string } | null;
      const views: Record<string, FocusView> = {};
      for (const [name, cdp] of pages) {
        const want = serverFocus?.quote ?? '';
        const read = async () => (await cdp.evaluate(VIEW)) as FocusView;
        views[name] = await until(
          `the ${name} page on the question`,
          async () => {
            const v = await read();
            return v.inView && v.highlighted === want ? v : null;
          },
          10_000,
        ).catch(read);
        if (shots) {
          const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
            data: string;
          };
          writeFileSync(join(shots, `focus-${i + 1}-${name}.png`), Buffer.from(png.data, 'base64'));
        }
      }
      steps.push({
        spoken: String(reply.spoken ?? ''),
        serverQuote: serverFocus?.quote ?? null,
        views,
      });
    }
    for (const [, cdp] of pages) cdp.close();
    voice.close();

    const run: AgentFocusRun = { cached: wide.cached && narrow.cached, before, steps };
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
