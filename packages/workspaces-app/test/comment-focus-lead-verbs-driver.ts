#!/usr/bin/env bun
/**
 * Typing a comment while a lead edits the doc with the verbs a lead really
 * sends, in headless Chromium against a real server and the real doc bundle.
 * The sibling `comment-focus-remote-edit-driver.ts` covers inserts and
 * find_and_replace beside the commented words; this one covers the rest of
 * what a lead sends: find_and_replace far away and on a table row,
 * apply_block_edits replace_block (which reads the outline first), a
 * suggestion and its acceptance through resolve_all, an edit while the
 * commented words are scrolled offscreen, and set_doc_content. Every doc has
 * a table, a code block and a mermaid diagram above the commented words.
 *
 * Prints one JSON line (`LeadVerbsRun`) for
 * `comment-focus-lead-verbs-browser.test.ts`.
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
import { AGENT, leadEdits } from './comment-focus-lead-verbs-edits.ts';
import type {
  LeadVerbStep,
  LeadVerbsReading,
  LeadVerbsScenario,
} from './comment-focus-lead-verbs-reading.ts';
import {
  ABOVE,
  CHUNKS,
  HELPERS,
  PHRASE,
  TARGET,
  para,
  scrollAnchorTo,
} from './comment-focus-remote-edit-page.ts';
import type { ComposerKind } from './comment-focus-remote-edit-reading.ts';

/** Past `onComposerOpened`'s 500ms keyboard fallback. */
const PAST_OPEN_FOLLOW_MS = 800;

const step = (what: string): void => {
  process.stderr.write(`[lead-verbs-driver] ${what}\n`);
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

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

interface Server {
  base: string;
  ws: string;
  post: (path: string, payload: unknown) => Promise<Record<string, unknown>>;
  handle: ServerHandle;
}

const TABLE = '| Berth | Opens |\n| --- | --- |\n| North | Spring |\n| South | Winter |';
const CODE =
  '```ts\nconst tide = readTideTable("Saltmarsh");\nexport const slipway = tide.high ? "north" : "south";\n```';
const MERMAID =
  '```mermaid\ngraph TD\n  A[Harborlight] --> B[Riverbend]\n  B --> C[Saltmarsh]\n```';

/** Thirty piers, with a table, a code block and a diagram above the
 *  commented words, and two sections below them for the heading verbs. */
function plan(): string {
  const out = ['# Harborlight ferry plan'];
  for (let i = 0; i < 30; i++) {
    out.push(para(i));
    if (i === 8) out.push(TABLE);
    if (i === 9) out.push(CODE, MERMAID);
    if (i === 18) out.push('## South piers');
    if (i === 26) out.push('## Old piers');
  }
  return out.join('\n\n');
}

/** The doc, and the thread above the commented words. */
async function makeDoc(
  s: Server,
  dir: string,
  name: string,
): Promise<{ docId: string; aboveThread: string }> {
  const file = join(dir, `${name}.md`);
  writeFileSync(file, plan());
  const docId = String(
    (await s.post(`/workspaces/${s.ws}/docs`, { docId: name, type: 'markdown', sourceUrl: file }))
      .docId,
  );
  await fetch(`${s.base}/workspaces/${s.ws}/docs/${docId}`);
  const ydoc = await until('the doc in memory', () => s.handle.docStore.get(docId)?.ydoc ?? null);
  // One thread per phrase, anchored exactly as the editor anchors one.
  let aboveThread = '';
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
    if (needle === ABOVE) aboveThread = id;
  }
  return { docId, aboveThread };
}

interface Page {
  cdp: Cdp;
  read: () => Promise<LeadVerbsReading>;
  settle: () => Promise<LeadVerbsReading>;
  /** Run a scroll, then wait for the margin to restack against it. */
  scrollAndRestack: (scroll: string) => Promise<void>;
  tap: (x: number, y: number) => Promise<void>;
}

/** The reader's words, as the doc would show them had they leaked into it. */
const READER_WORDS = CHUNKS.map((c) => c.trim());

async function openPage(
  url: string,
  width: number,
  height: number,
  kind: ComposerKind,
): Promise<Page> {
  const touch = width <= 1100;
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile),
    STARTUP_TIMEOUT_MS,
    `lead-verbs-${width}-${kind}-${process.pid}`,
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
  // A loaded runner, on request: `COMMENT_FOCUS_CPU_THROTTLE=4` runs the page
  // four times slower, so edits can land mid-keystroke as they do on CI.
  const throttle = Number(process.env.COMMENT_FOCUS_CPU_THROTTLE ?? 1);
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  if (touch) {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  // A returning reader: a first arrival gets the name prompt over the doc.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Bob'); } catch {}`,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  const cardSel = touch ? '#editor .cw-inline-card' : '.markup-margin .thread';
  // Both thread cards drawn, each with its reply editor mounted (the
  // composer chunk is lazy), and the diagram drawn.
  await until('two comment cards and the diagram', async () =>
    (await cdp.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(cardSel)})].filter((c) => c.querySelector('.md-composer-surface .ProseMirror')).length >= 2 && !!document.querySelector('#editor .cm-codeblock.is-mermaid .cm-diagram svg')`,
    ))
      ? true
      : null,
  );
  await cdp.evaluate(HELPERS(kind, cardSel));
  // Two readings the sibling driver has no use for: whether the reader's
  // words reached the doc itself, and how tall the diagram is.
  await cdp.evaluate(`(() => {
    const base = window.__read;
    const words = ${JSON.stringify(READER_WORDS)};
    window.__read = () => {
      const pm = document.querySelector('#editor .ProseMirror').cloneNode(true);
      for (const card of pm.querySelectorAll('.cw-inline-card')) card.remove();
      const prose = pm.textContent;
      const diagram = document.querySelector('#editor .cm-codeblock.is-mermaid');
      return {
        ...base(),
        leaked: words.filter((w) => prose.includes(w)),
        diagramHeight: diagram ? Math.round(diagram.getBoundingClientRect().height) : null,
      };
    };
    // The margin redraws every leader line each time it restacks, and it
    // restacks 100ms after a scroll stops, so this counts its passes.
    window.__restacks = 0;
    new MutationObserver(() => {
      window.__restacks += 1;
    }).observe(document.querySelector('.cw-leader-overlay'), { childList: true });
    return true;
  })()`);
  const read = async () => (await cdp.evaluate('__read()')) as LeadVerbsReading;
  return {
    cdp,
    read,
    settle: async () => {
      await cdp.evaluate('__settled()');
      return read();
    },
    scrollAndRestack: async (scroll) => {
      // In one evaluate, so a pass that ran before the scroll cannot count.
      // One still due may, and it reads the new scroll position.
      const passes = await cdp.evaluate(
        `(() => { const passes = window.__restacks; ${scroll}; return passes; })()`,
      );
      // No column at phone width: the box sits in the doc's flow.
      if (touch) return;
      await until('the margin to restack after the scroll', async () =>
        (await cdp.evaluate(`window.__restacks > ${passes}`)) ? true : null,
      );
    },
    tap: async (x, y) => {
      if (touch) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        return;
      }
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      }
    },
  };
}

async function openComposer(page: Page, kind: ComposerKind): Promise<void> {
  if (kind === 'new') {
    // Select the phrase the way a drag does, then tap the comment pill.
    await page.cdp.evaluate(`(() => {
      const pm = document.querySelector('#editor .ProseMirror');
      pm.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      const hit = __find(${JSON.stringify(PHRASE)});
      const r = document.createRange();
      r.setStart(hit.node, hit.at);
      r.setEnd(hit.node, hit.at + ${PHRASE.length});
      pm.focus({ preventScroll: true });
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      return true;
    })()`);
    const pill = await until(
      'the comment pill',
      async () =>
        (await page.cdp.evaluate(`(() => {
        const p = document.getElementById('comment-pill');
        if (!p || p.classList.contains('hidden') || !p.getClientRects().length) return null;
        const b = p.getBoundingClientRect();
        return b.width === 0 ? null : { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      })()`)) as { x: number; y: number } | null,
    );
    await page.tap(pill.x, pill.y);
  } else {
    // Open the card, then tap into its reply box.
    const face = (await page.cdp.evaluate(`(() => {
      const f = __card().querySelector('.face-summary') || __card();
      const b = f.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + Math.min(b.height / 2, 12) };
    })()`)) as { x: number; y: number };
    await page.tap(face.x, face.y);
    await page.settle();
    const box = await until(
      'the reply box on screen',
      async () =>
        (await page.cdp.evaluate(`(() => {
        const box = __box();
        if (!box || !box.getClientRects().length) return null;
        const b = box.getBoundingClientRect();
        return b.height > 0 ? { x: b.left + 20, y: b.top + b.height / 2 } : null;
      })()`)) as { x: number; y: number } | null,
    );
    await page.tap(box.x, box.y);
  }
  await until('the comment box holds focus', async () =>
    (await page.read()).focus === 'composer' ? true : null,
  );
}

async function scenario(
  s: Server,
  dir: string,
  width: number,
  height: number,
  kind: ComposerKind,
): Promise<LeadVerbsScenario> {
  const name = `lead-verbs-${width}-${kind}`;
  step(`${width}x${height} ${kind}`);
  const { docId, aboveThread } = await makeDoc(s, dir, name);
  const page = await openPage(`${s.base}/workspaces/${s.ws}/docs/${docId}`, width, height, kind);
  const home = scrollAnchorTo(Math.round(height * 0.3));
  await page.cdp.evaluate(home);
  await page.settle();
  await openComposer(page, kind);
  await sleep(PAST_OPEN_FOLLOW_MS);
  const opened = await page.settle();

  let typed = '';
  const type = async (text: string): Promise<void> => {
    for (const word of text.split(/(?<= )/)) {
      await page.cdp.send('Input.insertText', { text: word });
    }
    typed += text;
  };
  // Typing one key at a time, without waiting on the page, until `done`
  // resolves and then ten keys more: the reader who keeps typing while the
  // edit lands. Every key goes to wherever the caret is at that moment.
  const STREAM = CHUNKS.join('');
  let streamAt = 0;
  const typeThrough = async (done: Promise<unknown>): Promise<void> => {
    let landed = false;
    void done.then(() => {
      landed = true;
    });
    for (let extra = 0; extra < 10; ) {
      const ch = STREAM[streamAt++ % STREAM.length] ?? ' ';
      await page.cdp.send('Input.insertText', { text: ch });
      typed += ch;
      if (landed) extra++;
    }
  };
  await type(CHUNKS[0] ?? '');
  const steps: LeadVerbStep[] = [];
  const edits = leadEdits(s, docId, aboveThread, (expr) => page.cdp.evaluate(expr));
  for (const [i, edit] of edits.entries()) {
    if (edit.scrollAway) {
      await page.cdp.evaluate(
        `document.querySelector('#editor').scrollTop += ${height + 200}; true`,
      );
    }
    const before = await page.settle();
    const arrive = (async () => {
      await edit.run();
      await until(`the ${edit.where} edit on the page`, edit.landed);
    })();
    if (edit.typeThrough) await Promise.all([arrive, typeThrough(arrive)]);
    else await arrive;
    const landed = await page.settle();
    await type(CHUNKS[(i % (CHUNKS.length - 1)) + 1] ?? '');
    const after = await page.settle();
    steps.push({
      where: edit.where,
      typedThrough: edit.typeThrough === true,
      before,
      landed,
      after,
      typed,
    });
    if (edit.scrollAway) {
      // The reading the next step starts from is the box at rest. Before the
      // restack it is still where the last scroll left it.
      await page.scrollAndRestack(home);
      await page.settle();
    }
  }
  page.cdp.close();
  const mine = browsers.pop();
  if (mine) await stopBrowser(mine.proc, mine.profile);
  return { width, kind, opened, steps };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lead-verbs-'));
  let handle: ServerHandle | undefined;
  try {
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    step('build the doc bundle');
    const appPkg = process.env.COMMENT_FOCUS_APP ?? join(import.meta.dirname, '..');
    // Its own folder: the build deletes its output first, so a shared one
    // races any other driver building at the same time (scripts/build.ts).
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(appPkg, 'scripts', 'build.ts'), '--outdir', appDist],
      {
        encoding: 'utf8',
        timeout: 120_000,
        cwd: appPkg,
      },
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
    const scenarios: LeadVerbsScenario[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      for (const kind of ['new', 'reply'] as const) {
        scenarios.push(await scenario(s, dir, width, height, kind));
      }
    }
    // Past 64KB a pipe write is still in flight when `process.exit` runs, and
    // the reader gets a cut-off line: wait for it to drain.
    await new Promise<void>((resolve) =>
      process.stdout.write(`\n${JSON.stringify({ scenarios })}\n`, () => resolve()),
    );
  } finally {
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 470s');
  void Promise.all(browsers.map((b) => stopBrowser(b.proc, b.profile))).finally(() =>
    process.exit(3),
  );
}, 470_000).unref();
await main();
process.exit(0);
