#!/usr/bin/env bun
/**
 * Typing in the doc body while an agent edits the doc, in headless Chromium
 * against a real server and the real doc bundle.
 *
 * A long plan is opened at 1180x820 and at 430x932 with touch emulation. The
 * reader scrolls to the middle, taps into a paragraph and types. While they
 * type an agent inserts, replaces and deletes WHOLE blocks above and below
 * the caret, and lengthens a sentence above it, through the REST routes the
 * MCP tools call (`block_edits` for apply_block_edits and
 * insert_blocks_under_heading, `find_and_replace`). One scenario waits for
 * each edit to land; the other fires four of them inside a second, the way a
 * builder revising a doc section by section does, while the reader types on.
 *
 * Spawned by `body-typing-remote-edit-browser.test.ts`, which reads the JSON
 * it prints. `BODY_TYPING_APP=<dir>` builds the doc bundle from another
 * checkout's `packages/workspaces-app`, which is how the positive control
 * runs.
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
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { buildWidget } from '../../widget/test/frame-driver-kit.ts';
import {
  type BodyRun,
  type BodyScenario,
  type BodyStep,
  type CaretReading,
  FILLER,
  HELPERS,
  PLAN,
  WORDS,
} from './body-typing-remote-edit-page.ts';

const step = (what: string): void => {
  process.stderr.write(`[body-typing-driver] ${what}\n`);
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

/**
 * How far down the pane the caret sits, as a share of its height. Low enough
 * that whole blocks sit on screen between the pane's top edge and the caret,
 * which is where an edit moves the caret without moving the top line.
 */
const CARET_AT = 0.6;

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];
const AGENT = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };

interface Server {
  base: string;
  ws: string;
  post: (path: string, payload: unknown) => Promise<Record<string, unknown>>;
}

/** One agent edit: what it sends, and what the page shows once it landed. */
interface Edit {
  where: string;
  run: (s: Server, docId: string) => Promise<unknown>;
  /** True once the page's prose shows the edit. */
  landed: string;
}

/** The outline id of the block whose text starts with `prefix`. */
async function blockId(s: Server, docId: string, prefix: string): Promise<string> {
  const res = await fetch(`${s.base}/workspaces/${s.ws}/docs/${docId}/outline`);
  const { blocks } = (await res.json()) as { blocks: Array<{ id: string; text: string }> };
  const hit = blocks.find((b) => b.text.startsWith(prefix));
  if (!hit) throw new Error(`no block starting "${prefix}"`);
  return hit.id;
}

const blockEdits = (s: Server, docId: string, edits: unknown[]) =>
  s.post(`/workspaces/${s.ws}/docs/${docId}/block_edits`, { author: AGENT, edits });

const hasText = (t: string) =>
  `document.querySelector('#editor .ProseMirror').textContent.includes(${JSON.stringify(t)})`;
const lacksText = (t: string) => `!(${hasText(t)})`;

const insertUnder = (where: string, heading: string, tag: string): Edit => ({
  where,
  run: async (s, docId) =>
    blockEdits(s, docId, [
      {
        op: 'insert_under_heading',
        headingId: await blockId(s, docId, heading),
        markdown: `${tag} pilots board every inbound ferry. ${FILLER}\n\n### ${tag} rota\n\n${FILLER} ${FILLER}`,
      },
    ]),
  landed: hasText(`${tag} rota`),
});
const replaceBlock = (where: string, pier: number, tag: string): Edit => ({
  where,
  run: async (s, docId) =>
    blockEdits(s, docId, [
      {
        op: 'replace_block',
        blockId: await blockId(s, docId, `Pier ${pier}:`),
        markdown: `${tag} replaces pier ${pier}. ${FILLER}\n\n${tag} adds a second paragraph. ${FILLER} ${FILLER}`,
      },
    ]),
  landed: hasText(`${tag} adds a second paragraph`),
});
const deleteBlock = (where: string, pier: number): Edit => ({
  where,
  run: async (s, docId) =>
    blockEdits(s, docId, [
      { op: 'delete_block', blockId: await blockId(s, docId, `Pier ${pier}:`) },
    ]),
  landed: lacksText(`Pier ${pier}:`),
});
const lengthen = (where: string, pier: number, tag: string): Edit => ({
  where,
  run: (s, docId) =>
    s.post(`/workspaces/${s.ws}/docs/${docId}/find_and_replace`, {
      author: AGENT,
      find: `Pier ${pier}: The Riverbend crossing`,
      replace: `Pier ${pier}: ${tag} lengthens this. ${FILLER} The Riverbend crossing`,
    }),
  landed: hasText(`${tag} lengthens this`),
});

/** One at a time: each lands, then the reader types a word. */
const ONE_BY_ONE: Edit[] = [
  insertUnder('above: insert under a heading', 'Section 2', 'Harborlight'),
  replaceBlock('above: replace a block', 16, 'Riverbend'),
  deleteBlock('above: delete a block', 15),
  lengthen('above: lengthen a sentence', 14, 'Saltmarsh'),
  insertUnder('below: insert under a heading', 'Section 3', 'Saltmarsh'),
  replaceBlock('below: replace a block', 18, 'Harborlight'),
  deleteBlock('below: delete a block', 19),
];
/** Fired inside a second, a word typed between each. */
const BURST: Edit[] = [
  insertUnder('burst', 'Section 2', 'Harborlight'),
  replaceBlock('burst', 16, 'Riverbend'),
  replaceBlock('burst', 18, 'Saltmarsh'),
  deleteBlock('burst', 12),
];

interface Page {
  cdp: Cdp;
  read: () => Promise<CaretReading>;
  settle: () => Promise<CaretReading>;
}

async function openPage(url: string, width: number, height: number): Promise<Page> {
  const touch = width <= 1100;
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile),
    STARTUP_TIMEOUT_MS,
    `body-typing-${width}-${process.pid}`,
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
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Bob'); } catch {}`,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  await until('the doc editable', async () =>
    (await cdp.evaluate(
      `(() => { const pm = document.querySelector('#editor .ProseMirror'); return !!pm && pm.isContentEditable && pm.textContent.includes('Pier 29:'); })()`,
    ))
      ? true
      : null,
  );
  await cdp.evaluate(HELPERS);
  const read = async () => (await cdp.evaluate('__read()')) as CaretReading;
  return {
    cdp,
    read,
    settle: async () => {
      await cdp.evaluate('__settled()');
      return read();
    },
  };
}

/** Tap into the paragraph after the caret words, the way a reader does,
 *  then put the caret exactly there. */
async function tapIntoBody(page: Page, width: number): Promise<void> {
  const spot = (await page.cdp.evaluate('__caretSpot()')) as { x: number; y: number };
  if (width <= 1100) {
    await page.cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: spot.x, y: spot.y }],
    });
    await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.cdp.send('Input.dispatchMouseEvent', {
        type,
        x: spot.x,
        y: spot.y,
        button: 'left',
        clickCount: 1,
      });
    }
  }
  await until('the doc holds focus', async () =>
    (await page.read()).focus === 'doc' ? true : null,
  );
  await page.cdp.evaluate('__placeCaret()');
  await until('the caret after the words', async () =>
    (await page.read()).beforeCaret?.endsWith('The quiet berth') ? true : null,
  );
}

async function scenario(
  s: Server,
  dir: string,
  width: number,
  height: number,
  mode: BodyScenario['mode'],
): Promise<BodyScenario> {
  const name = `body-${width}-${mode}`;
  step(`${width}x${height} ${mode}`);
  const file = join(dir, `${name}.md`);
  // The agent writes the plan, so its later block edits apply directly
  // rather than as proposals, as they do on a doc a builder is revising.
  const [title, ...body] = PLAN.split('\n\n');
  writeFileSync(file, `${title}\n`);
  const docId = String(
    (await s.post(`/workspaces/${s.ws}/docs`, { docId: name, type: 'markdown', sourceUrl: file }))
      .docId,
  );
  await blockEdits(s, docId, [{ op: 'insert_at_end', markdown: body.join('\n\n') }]);
  const page = await openPage(`${s.base}/workspaces/${s.ws}/docs/${docId}`, width, height);
  await page.cdp.evaluate(`__scrollCaretTo(${Math.round(height * CARET_AT)})`);
  await page.settle();
  await tapIntoBody(page, width);
  const opened = await page.settle();

  const words = [...WORDS];
  let typed = '';
  const type = async (): Promise<void> => {
    const w = words.shift();
    if (w === undefined) return;
    await page.cdp.send('Input.insertText', { text: w });
    typed += w;
  };
  const landedAll = async (edits: Edit[]) =>
    until('the edits on the page', async () =>
      (await page.cdp.evaluate(`[${edits.map((e) => e.landed).join(',')}].every(Boolean)`))
        ? true
        : null,
    );

  await type();
  const steps: BodyStep[] = [];
  if (mode === 'one-by-one') {
    for (const edit of ONE_BY_ONE) {
      const before = await page.settle();
      await edit.run(s, docId);
      await landedAll([edit]);
      const landed = await page.settle();
      await type();
      const after = await page.settle();
      steps.push({ where: edit.where, before, landed, after, typed });
    }
  } else {
    const before = await page.settle();
    const t0 = Date.now();
    for (const edit of BURST) {
      await edit.run(s, docId);
      await type();
    }
    const firedMs = Date.now() - t0;
    if (firedMs >= 1000) throw new Error(`the burst took ${firedMs}ms, not under a second`);
    await landedAll(BURST);
    const landed = await page.settle();
    await type();
    const after = await page.settle();
    steps.push({ where: `burst of ${BURST.length} in ${firedMs}ms`, before, landed, after, typed });
  }
  await type();
  const final = await page.settle();
  page.cdp.close();
  return { width, height, mode, opened, steps, final, typed };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'body-typing-'));
  let handle: ServerHandle | undefined;
  try {
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    step('build the doc bundle');
    const appPkg = process.env.BODY_TYPING_APP ?? join(import.meta.dirname, '..');
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
    const s: Server = { base, ws, post };
    const scenarios: BodyScenario[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      for (const mode of ['one-by-one', 'burst'] as const) {
        scenarios.push(await scenario(s, dir, width, height, mode));
      }
    }
    const run: BodyRun = { scenarios };
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
