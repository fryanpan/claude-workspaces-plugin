#!/usr/bin/env bun
/**
 * Typing a comment while an agent edits the doc, in headless Chromium against
 * a real server and the real doc bundle.
 *
 * A long plan is opened at 1180x820 (the iPad in landscape, where comments
 * are balloons in the margin) and at 430x932 (inline cards). The reader
 * scrolls to the middle, opens a comment box — a new comment off a selected
 * phrase, or the reply box of an existing thread — and types. While they type
 * an agent edits the doc through the same REST routes the MCP edit tools
 * call: blocks inserted ABOVE the commented words, a sentence lengthened
 * BELOW them, and the commented paragraph itself rewritten around them. The
 * reader types more after each edit.
 *
 * Each scenario gets its own doc, so one scenario's edits cannot move another
 * scenario's anchor. Spawned by `comment-focus-remote-edit-browser.test.ts`,
 * which reads the JSON it prints. `COMMENT_FOCUS_APP=<dir>` builds the doc
 * bundle from another checkout's `packages/workspaces-app`, which is how the
 * positive control runs.
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
import type {
  ComposerKind,
  EditStep,
  FocusReading,
  FocusRun,
  FocusScenario,
} from './comment-focus-remote-edit-reading.ts';

const FILLER =
  'The Riverbend crossing carries commuters at dawn and freight at noon, and the ' +
  'Saltmarsh tide table decides which of the two slipways can take a loaded ferry.';
/** The thread above the reader's place: the agent inserts blocks after it. */
const ABOVE = 'north berth';
/** The thread the reader replies to. */
const TARGET = 'middle berth';
/** The phrase the reader selects for a new comment. */
const PHRASE = 'quiet berth';
/** The sentence the agent lengthens below the reader's place. */
const BELOW = 'The south berth closes in winter.';
/** The sentence in the commented paragraph the agent rewrites. */
const INSIDE = 'Bob counts the bollards.';

const para = (i: number): string => {
  if (i === 4) return `${FILLER} The ${ABOVE} opens in spring.`;
  if (i === 14) return `${FILLER} The ${TARGET} opens in spring. ${INSIDE}`;
  if (i === 15) return `${FILLER} The ${PHRASE} opens in spring. ${INSIDE}`;
  if (i === 24) return `${FILLER} ${BELOW}`;
  return `${FILLER} ${FILLER}`;
};
const PLAN = ['# Harborlight ferry plan', ...Array.from({ length: 30 }, (_, i) => para(i))].join(
  '\n\n',
);

/** What the reader types, a chunk before the first edit and after each one. */
const CHUNKS = [
  'Alice signs off the berth ',
  'once the Saltmarsh survey is back ',
  'and the tide table agrees, ',
  'so Bob checks the Riverbend slipway first.',
];

/** Past `onComposerOpened`'s 500ms keyboard fallback. */
const PAST_OPEN_FOLLOW_MS = 800;

const step = (what: string): void => {
  process.stderr.write(`[comment-focus-driver] ${what}\n`);
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
 * The page-side helpers. `__box()` is the editable surface the reader types
 * into: the new-comment composer's, or the reply box of the target thread's
 * card (a margin balloon at 1180, an inline card at 430).
 */
const HELPERS = (kind: ComposerKind, cardSel: string) => `(() => {
  const TARGET = ${JSON.stringify(TARGET)};
  const PHRASE = ${JSON.stringify(PHRASE)};
  window.__card = () => [...document.querySelectorAll(${JSON.stringify(cardSel)})]
    .find((c) => (c.textContent || '').includes('Who signs off the ' + TARGET));
  window.__box = () => {
    ${
      kind === 'new'
        ? `return document.querySelector('#composer .md-composer-surface .ProseMirror');`
        : `const card = __card();
    return card ? card.querySelector('.thread-reply .md-composer-surface .ProseMirror') : null;`
    }
  };
  /** The text node and offset of a phrase inside the doc's ProseMirror. */
  window.__find = (needle) => {
    const root = document.querySelector('#editor .ProseMirror');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.data.indexOf(needle);
      if (at >= 0 && !n.parentElement.closest('.cw-inline-card, .thread')) return { node: n, at };
    }
    return null;
  };
  window.__anchorTop = () => {
    const hit = __find(${kind === 'new' ? 'PHRASE' : 'TARGET'});
    if (!hit) return null;
    const r = document.createRange();
    r.setStart(hit.node, hit.at);
    r.setEnd(hit.node, hit.at + 1);
    return Math.round(r.getBoundingClientRect().top);
  };
  window.__read = () => {
    const box = __box();
    const a = document.activeElement;
    const drawn = box && box.getClientRects().length > 0;
    return {
      focus: box && (a === box || box.contains(a)) ? 'composer'
        : a && a.closest && a.closest('#editor .ProseMirror') && !a.closest('.thread, .cw-inline-card') ? 'doc'
        : a === document.body || a === null ? 'body' : 'other',
      text: box ? box.textContent : null,
      boxTop: drawn ? Math.round(box.getBoundingClientRect().top) : null,
      scrollTop: Math.round(document.querySelector('#editor').scrollTop),
      anchorTop: __anchorTop(),
    };
  };
  window.__settled = async () => {
    // Settled: no animation running, and the scroller still across a frame.
    for (let i = 0; i < 300; i++) {
      const moving = document.getAnimations().some((x) => x.playState === 'running');
      const before = document.querySelector('#editor').scrollTop;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (!moving && document.querySelector('#editor').scrollTop === before) return true;
    }
    return false;
  };
  return true;
})()`;

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

interface Server {
  base: string;
  ws: string;
  post: (path: string, payload: unknown) => Promise<Record<string, unknown>>;
  handle: ServerHandle;
}

const AGENT = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };

/** A fresh copy of the plan with a thread on ABOVE and one on TARGET. */
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
  // One thread per phrase, anchored exactly as the editor anchors one.
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
  read: () => Promise<FocusReading>;
  settle: () => Promise<FocusReading>;
  tap: (x: number, y: number) => Promise<void>;
}

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
    `comment-focus-${width}-${kind}-${process.pid}`,
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
  // A returning reader: a first arrival gets the name prompt over the doc.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Bob'); } catch {}`,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  const cardSel = touch ? '#editor .cw-inline-card' : '.markup-margin .thread';
  // Both thread cards drawn, each with its reply editor mounted (the
  // composer chunk is lazy).
  await until('two comment cards', async () =>
    Number(
      await cdp.evaluate(
        `[...document.querySelectorAll(${JSON.stringify(cardSel)})].filter((c) => c.querySelector('.md-composer-surface .ProseMirror')).length`,
      ),
    ) >= 2
      ? true
      : null,
  );
  await cdp.evaluate(HELPERS(kind, cardSel));
  const read = async () => (await cdp.evaluate('__read()')) as FocusReading;
  return {
    cdp,
    read,
    settle: async () => {
      await cdp.evaluate('__settled()');
      return read();
    },
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
  };
}

/** Put the commented words `offset` pixels below the editor's top edge. */
const scrollAnchorTo = (offset: number) => `(() => {
  const ed = document.querySelector('#editor');
  ed.scrollTop += __anchorTop() - ed.getBoundingClientRect().top - ${offset};
  return true;
})()`;

async function openComposer(page: Page, kind: ComposerKind): Promise<void> {
  if (kind === 'new') {
    // Select the phrase the way a drag does — a pointer goes down on the
    // words, the selection lands, the pointer comes up — then tap the
    // comment pill. The pill shows on the gesture's end (`gesture.ts`).
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
    const pill = await until('the comment pill', async () => {
      const r = (await page.cdp.evaluate(`(() => {
        const p = document.getElementById('comment-pill');
        if (!p || p.classList.contains('hidden') || !p.getClientRects().length) return null;
        const b = p.getBoundingClientRect();
        if (b.width === 0) return null;
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      })()`)) as { x: number; y: number } | null;
      return r;
    });
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
): Promise<FocusScenario> {
  const name = `ferry-${width}-${kind}`;
  step(`${width}x${height} ${kind}: ${name}`);
  const { docId, threads } = await makeDoc(s, dir, name);
  const page = await openPage(`${s.base}/workspaces/${s.ws}/docs/${docId}`, width, height, kind);
  await page.cdp.evaluate(scrollAnchorTo(Math.round(height * 0.3)));
  await page.settle();
  await openComposer(page, kind);
  // Past the composer's own move: once open, the sheet scrolls the doc to
  // clear the commented words of the keyboard, on a 500ms fallback when no
  // keyboard resize arrives (`doc-comment-pill.ts`, `onComposerOpened`). The
  // reader is mid-comment, not mid-open, when the agent's edits land.
  await sleep(PAST_OPEN_FOLLOW_MS);
  const opened = await page.settle();

  let typed = '';
  const type = async (text: string): Promise<void> => {
    // One word at a time, the way a keyboard sends them.
    for (const word of text.split(/(?<= )/)) {
      await page.cdp.send('Input.insertText', { text: word });
    }
    typed += text;
  };
  const edits: Array<{ where: EditStep['where']; marker: string; run: () => Promise<unknown> }> = [
    {
      where: 'above',
      marker: 'Harborlight pilots board',
      run: () =>
        s.post(`/workspaces/${s.ws}/docs/${docId}/threads/${threads[ABOVE]}/insert_blocks_after`, {
          author: AGENT,
          markdown: `Harborlight pilots board every inbound ferry. ${FILLER}\n\n## Pilot rota\n\n${FILLER} ${FILLER}`,
        }),
    },
    {
      where: 'below',
      marker: 'The south berth closes in winter and floods',
      run: () =>
        s.post(`/workspaces/${s.ws}/docs/${docId}/find_and_replace`, {
          author: AGENT,
          find: BELOW,
          replace: `The south berth closes in winter and floods at spring tide. ${FILLER} ${FILLER}`,
        }),
    },
    {
      where: 'inside',
      marker: 'Bob counts the bollards twice',
      run: () =>
        s.post(`/workspaces/${s.ws}/docs/${docId}/find_and_replace`, {
          author: AGENT,
          find: INSIDE,
          contextBefore: `The ${kind === 'new' ? PHRASE : TARGET} opens in spring. `,
          replace: `Bob counts the bollards twice, once at each tide. ${FILLER}`,
        }),
    },
  ];

  await type(CHUNKS[0] ?? '');
  const steps: EditStep[] = [];
  for (const [i, edit] of edits.entries()) {
    const before = await page.settle();
    await edit.run();
    await until(`the ${edit.where} edit on the page`, async () =>
      (await page.cdp.evaluate(
        `document.querySelector('#editor .ProseMirror').textContent.includes(${JSON.stringify(edit.marker)})`,
      ))
        ? true
        : null,
    );
    // The card re-anchors and the margin relays out on the frames after the
    // update lands; read once that has finished.
    const landed = await page.settle();
    // The reader keeps typing. Whatever box holds focus gets the words.
    await type(CHUNKS[i + 1] ?? '');
    const after = await page.settle();
    steps.push({ where: edit.where, before, landed, after, typed });
  }
  const final = await page.settle();
  page.cdp.close();
  return { width, height, kind, opened, steps, final, typed };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'comment-focus-'));
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

    const scenarios: FocusScenario[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      for (const kind of ['new', 'reply'] as const) {
        scenarios.push(await scenario(s, dir, width, height, kind));
      }
    }
    const run: FocusRun = { scenarios };
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
