#!/usr/bin/env bun
/**
 * Edit mode end to end, in headless Chromium against a real board server.
 *
 * Two pages, because the widget lives on two kinds: a dev server this server
 * cannot read (a plain page on its own port that embeds the tag and the
 * script), and a mock the board serves in a sandboxed frame. On each, the
 * driver taps the pencil, taps the heading, types new words with real input
 * events and presses Send. It then reads what the board stored, reads the
 * page's source back to show nothing wrote it, reloads, and reads the words
 * and the marks the page shows. Last, it plays the agent: rewrites the source
 * with the new words, resolves the thread, reloads, and reads the marks
 * again.
 *
 * Spawned by `edit-mode-browser.test.ts`, which reads the JSON it prints.
 *
 * Nothing here reads a source file, a bundle or a stylesheet to assert on;
 * the page sources it reads back are the fixtures it wrote, and every other
 * value came from the running page and server.
 */
// audit: no-text
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PageEdit } from '@claude-workspaces/core/page-edits';
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

const BEFORE = 'Harborlight Street Projects';
const AFTER = 'Harborlight Street Works';

/** What one page showed, read at each step. */
export interface Scenario {
  /** The edits the board stored on the send's thread. */
  stored: Array<Pick<PageEdit, 'selector' | 'before' | 'after'> & { anchorKind: string }>;
  /** The stored comment's words. */
  text: string | null;
  /** The page's source was byte-identical after the send. */
  sourceUnchanged: boolean;
  /** After a reload with the edit still waiting. */
  reloaded: Marks;
  /** After the agent applied it and the page reloaded. */
  applied: Marks;
  /** The same, inside edit mode. */
  appliedInMode: Marks;
}

export interface Marks {
  /** The heading's words as the page shows them. */
  heading: string | null;
  /** Orange bars, and green ones. */
  pending: number;
  green: number;
  /** The first orange bar sits beside the heading: its vertical span
   *  overlaps the heading's. */
  besideHeading: boolean;
  /** The most opaque wash's background alpha: at or near 1 would paint over
   *  the words it marks. 0 when no wash is up. */
  washAlpha: number;
}

const TAG = 'claude-feedback-widget';

const body = (title: string) =>
  `<h1 id="title">${title}</h1><p id="lede">Riverbend <b>opens</b> at nine.</p>` +
  '<p><a href="/elsewhere">Saltmarsh ferry times</a></p>';

/** A dev server's page: it embeds the widget from the board, as the
 *  embedding instructions say. */
const devPage = (title: string, board: string, ws: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Harborlight</title>
<style>body{font:16px/1.5 system-ui;margin:0;padding:40px 60px}</style></head>
<body>${body(title)}
<${TAG} doc-id="harborlight-dev" workspace-id="${ws}" user="Alice" server-url="ws://${board}"></${TAG}>
<script src="http://${board}/widget.iife.js"></script>
</body></html>`;

/** A mock the board serves; the server writes the widget into its frame. */
const mockPage = (title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Harborlight mock</title>
<style>body{font:16px/1.5 system-ui;margin:0;padding:40px 60px}</style></head>
<body>${body(title)}</body></html>`;

async function buildWidget(dist: string): Promise<void> {
  const src = (f: string) => join(import.meta.dirname, '../src', f);
  const built = await Bun.build({
    entrypoints: [
      src('widget-iife.ts'),
      src('mockup-live.ts'),
      src('mic-entry.ts'),
      src('voice/voice-entry.ts'),
      src('edit/edit-entry.ts'),
      src('mock-bridge.ts'),
      src('mock-host.ts'),
    ],
    outdir: dist,
    target: 'browser',
    format: 'iife',
    naming: '[name].js',
  });
  if (!built.success) throw new Error(`widget build failed: ${built.logs.join('\n')}`);
  renameSync(join(dist, 'widget-iife.js'), join(dist, 'widget.iife.js'));
  renameSync(join(dist, 'mic-entry.js'), join(dist, 'mic.js'));
  renameSync(join(dist, 'voice-entry.js'), join(dist, 'voice.js'));
  renameSync(join(dist, 'edit-entry.js'), join(dist, 'edit.js'));
}

const step = (what: string): void => {
  process.stderr.write(`[edit-mode-driver] ${what}\n`);
};

async function poll<T>(what: string, read: () => Promise<T | null> | T | null): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

/** Where the page's own content is evaluated: the page itself, or the
 *  sandboxed frame's CDP session. */
interface Surface {
  eval(expr: string): Promise<unknown>;
  /** Page coordinates of the surface's viewport origin. */
  offset(): Promise<{ x: number; y: number }>;
}

function pageSurface(cdp: Cdp): Surface {
  return { eval: (e) => cdp.evaluate(e), offset: async () => ({ x: 0, y: 0 }) };
}

function frameSurface(cdp: Cdp, sessions: string[]): Surface {
  const inFrame = async (expression: string): Promise<unknown> => {
    for (const sessionId of [...sessions]) {
      const r = (await cdp
        .send(
          'Runtime.evaluate',
          {
            expression: `(() => { if (!document.getElementById('title')) return '__none__'; return (${expression}); })()`,
            returnByValue: true,
            awaitPromise: true,
          },
          sessionId,
        )
        .catch(() => null)) as { result?: { value?: unknown } } | null;
      const v = r?.result?.value;
      if (v !== '__none__' && r) return v;
    }
    return null;
  };
  return {
    eval: inFrame,
    offset: async () =>
      (await cdp.evaluate(
        `(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`,
      )) as { x: number; y: number },
  };
}

async function frameSessions(cdp: Cdp): Promise<string[]> {
  const sessions: string[] = [];
  cdp.on('Target.attachedToTarget', (p) => {
    const sessionId = p.sessionId as string;
    if ((p.targetInfo as { type?: string } | undefined)?.type === 'iframe') {
      sessions.push(sessionId);
    }
    void cdp
      .send('Runtime.enable', {}, sessionId)
      .then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId))
      .catch(() => {});
  });
  cdp.on('Target.detachedFromTarget', (p) => {
    const i = sessions.indexOf(p.sessionId as string);
    if (i >= 0) sessions.splice(i, 1);
  });
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  return sessions;
}

/** The centre of a node, in page coordinates. `find` is an expression for
 *  the node on the surface. */
async function centre(s: Surface, find: string): Promise<{ x: number; y: number } | null> {
  const r = (await s.eval(
    `(() => { const e = ${find}; if (!e) return null; const b = e.getBoundingClientRect(); if (!b.width) return null; return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
  )) as { x: number; y: number } | null;
  if (!r) return null;
  const o = await s.offset();
  return { x: r.x + o.x, y: r.y + o.y };
}

async function tap(cdp: Cdp, s: Surface, find: string, what: string): Promise<void> {
  const at = await poll(what, () => centre(s, find));
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: at.x,
      y: at.y,
      button: 'left',
      clickCount: 1,
    });
  }
}

const SHADOW = `document.querySelector('${TAG}')?.shadowRoot`;
const PENCIL = `${SHADOW}?.querySelector('.fab-edit')`;
const SEND = `${SHADOW}?.querySelector('.cw-edit-banner .edit-send:not([hidden])')`;
const HEADING = `document.getElementById('title')`;

const MARKS = `(() => {
  const h = document.getElementById('title');
  const hr = h ? h.getBoundingClientRect() : null;
  const bars = [...document.querySelectorAll('.cfw-edit-bar')];
  const pending = bars.filter((b) => !b.classList.contains('applied'));
  const first = pending[0]?.getBoundingClientRect();
  return {
    heading: h ? h.textContent.trim() : null,
    pending: pending.length,
    green: bars.length - pending.length,
    besideHeading: !!(first && hr && first.top < hr.bottom && first.bottom > hr.top),
    washAlpha: Math.max(0, ...[...document.querySelectorAll('.cfw-edit-wash')].map((w) => {
      const m = getComputedStyle(w).backgroundColor.match(/rgba?\(([^)]*)\)/);
      const parts = m ? m[1].split(',') : [];
      return parts.length === 4 ? Number(parts[3]) : parts.length === 3 ? 1 : 0;
    })),
  };
})()`;

/** Wait for the marks to settle on a freshly loaded page: the edit chunk
 *  loads once the doc says an edit is waiting, and paints a frame later. */
async function readMarks(s: Surface, want: (m: Marks) => boolean): Promise<Marks> {
  let last: Marks | null = null;
  try {
    return await poll('the marks settled', async () => {
      last = (await s.eval(MARKS)) as Marks | null;
      return last && want(last) ? last : null;
    });
  } catch {
    return last ?? { heading: null, pending: 0, green: 0, besideHeading: false, washAlpha: 0 };
  }
}

/**
 * Hold the Send's answer until the page has reloaded.
 *
 * The board stores the thread before it answers, so a reader who reloads in
 * that gap reloads a page that never heard its send succeed. On a loaded
 * runner the gap is wide enough to land in by accident; this makes every run
 * land in it. The answer is paused at the Response stage on every target
 * that could send it (the page, and a mock's frame), and released — into a
 * page that is gone — once `release` is called.
 */
async function holdSendAnswer(
  cdp: Cdp,
  sessions: readonly string[],
): Promise<{ held: () => number; release: () => Promise<void> }> {
  const paused: Array<{ requestId: string; sessionId?: string }> = [];
  const targets: Array<string | undefined> = [undefined, ...sessions];
  cdp.on('Fetch.requestPaused', (p, sessionId) => {
    const requestId = p.requestId as string;
    // A cross-origin send is preceded by its preflight; only the POST waits.
    if ((p.request as { method?: string } | undefined)?.method !== 'POST') {
      void cdp.send('Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
      return;
    }
    paused.push({ requestId, ...(sessionId ? { sessionId } : {}) });
  });
  for (const t of targets) {
    await cdp
      .send(
        'Fetch.enable',
        { patterns: [{ urlPattern: '*/threads', requestStage: 'Response' }] },
        t,
      )
      .catch(() => {});
  }
  return {
    held: () => paused.length,
    release: async () => {
      for (const r of paused.splice(0)) {
        await cdp
          .send('Fetch.continueRequest', { requestId: r.requestId }, r.sessionId)
          .catch(() => {});
      }
      for (const t of targets) await cdp.send('Fetch.disable', {}, t).catch(() => {});
    },
  };
}

async function editHeading(cdp: Cdp, s: Surface): Promise<void> {
  step('waiting for the pencil');
  await poll('the pencil arrived', () => s.eval(`!!${PENCIL}`).then((v) => (v ? true : null)));
  await enterEditMode(cdp, s);
  await tap(cdp, s, HEADING, 'the heading');
  await poll('the heading is being edited', () =>
    s.eval(`${HEADING}.isContentEditable`).then((v) => (v ? true : null)),
  );
  await s.eval(`document.execCommand('selectAll')`);
  await cdp.send('Input.insertText', { text: AFTER });
  await poll('the heading shows the new words', () =>
    s.eval(`${HEADING}.textContent.trim()`).then((v) => (v === AFTER ? true : null)),
  );
  await tap(cdp, s, SEND, 'the Send button');
}

/** Tap the pencil until edit mode is on. Right after a mock's frame loads,
 *  a tap on the pencil can reach the frame with nothing arriving: the frame's
 *  own hit test puts the pencil under the point and the pencil counts no
 *  click. Measured over 17 driver runs: a miss in 13, each on the first tap
 *  after the mock loaded, and the second tap landed every time. So a tap is
 *  confirmed and retried,
 *  and each miss is logged with the pencil's click count: a pencil that took
 *  the click and still did not open is a product failure and stops here. */
async function enterEditMode(cdp: Cdp, s: Surface): Promise<void> {
  const on = () => s.eval(`!!${SHADOW}?.querySelector('.cw-edit-banner')`);
  await s.eval(
    `(() => { const p = ${PENCIL}; if (p && !p.__taps) { p.__taps = { n: 0 }; p.addEventListener('click', () => p.__taps.n++); } return true; })()`,
  );
  for (let attempt = 1; attempt <= 3; attempt++) {
    await tap(cdp, s, PENCIL, 'the pencil');
    for (let i = 0; i < 60; i++) {
      if (await on()) return;
      await sleep(50);
    }
    const clicks = await s.eval(`${PENCIL}?.__taps?.n ?? 0`);
    step(
      `tap ${attempt} on the pencil did not open edit mode; the pencil counted ${String(clicks)} clicks`,
    );
    if (clicks !== 0) break;
  }
  throw new Error('never happened: edit mode is on');
}

async function reload(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
}

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'edit-mode-'));
  let handle: ServerHandle | undefined;
  let dev: ReturnType<typeof Bun.serve> | undefined;
  try {
    const dist = join(dir, 'widget');
    await buildWidget(dist);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      requireSignInToWrite: false,
    });
    const h = handle;
    const board = `127.0.0.1:${h.port}`;
    const base = `http://${board}`;
    const post = async (path: string, payload: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const agent = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author: agent })) as {
        workspace: { id: string };
      }
    ).workspace.id;

    // The dev server: one page, from a file only it reads.
    const devFile = join(dir, 'dev.html');
    writeFileSync(devFile, devPage(BEFORE, board, ws));
    dev = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(readFileSync(devFile, 'utf8'), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        }),
    });
    const devUrl = `http://127.0.0.1:${dev.port}/`;

    // The mock: bound from a file, served by the board.
    const mockFile = join(dir, 'mock.html');
    writeFileSync(mockFile, mockPage(BEFORE));
    const mockId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'harborlight-mock',
          type: 'mockup',
          sourceUrl: mockFile,
        })
      ).docId,
    );
    await post(`/workspaces/${ws}/docs:attach`, { docId: mockId });
    const mockUrl = `${base}/workspaces/${ws}/mockups/${mockId}`;

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `edit-mode-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // A page holding unsent edits asks before it unloads. Every reload here
    // follows a send, so a dialog is a failed send: accept it and let the
    // readings say so.
    cdp.on('Page.javascriptDialogOpening', () => {
      step('a dialog opened: accepting it');
      void cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
    const sessions = await frameSessions(cdp);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1180,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const run = async (
      url: string,
      docId: () => string,
      surface: Surface,
      file: string,
      applied: string,
    ): Promise<Scenario> => {
      step(`open ${url}`);
      await reload(cdp, url);
      const original = readFileSync(file, 'utf8');
      const hold = await holdSendAnswer(cdp, sessions);
      await editHeading(cdp, surface);
      step('sent');
      const thread = await poll(
        'the send reached the board',
        () => h.docStore.listThreads(docId()).find((t) => t.comments[0]?.pageEdits) ?? null,
      );
      const first = thread.comments[0];
      const sourceUnchanged = readFileSync(file, 'utf8') === original;
      await poll("the send's answer is held", () => (hold.held() > 0 ? true : null));
      step('stored, answer held; reloading');
      await reload(cdp, url);
      await hold.release();
      const reloaded = await readMarks(surface, (m) => m.pending > 0);
      // The agent: apply the edit to the source, resolve the thread.
      writeFileSync(file, applied);
      await post(`/workspaces/${ws}/docs/${docId()}/threads/${thread.id}/resolve`, {
        author: agent,
      });
      step('applied; reloading');
      await reload(cdp, url);
      const appliedMarks = await readMarks(surface, (m) => m.heading === AFTER);
      await enterEditMode(cdp, surface);
      const appliedInMode = await readMarks(surface, (m) => m.green > 0);
      return {
        stored: (first?.pageEdits ?? []).map((e) => ({
          selector: e.selector,
          before: e.before,
          after: e.after,
          anchorKind: e.anchor.kind,
        })),
        text: first?.text ?? null,
        sourceUnchanged,
        reloaded,
        applied: appliedMarks,
        appliedInMode,
      };
    };

    const devDoc = (): string => 'harborlight-dev';
    const devScenario = await run(
      devUrl,
      devDoc,
      pageSurface(cdp),
      devFile,
      devPage(AFTER, board, ws),
    );
    const mockScenario = await run(
      mockUrl,
      () => mockId,
      frameSurface(cdp, sessions),
      mockFile,
      mockPage(AFTER),
    );
    cdp.close();
    process.stdout.write(`\n${JSON.stringify({ dev: devScenario, mock: mockScenario })}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    dev?.stop(true);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

// A driver that never finishes holds a browser open; the test's own spawn
// timeout is longer than this.
setTimeout(() => {
  step('gave up after 200s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 200_000).unref();
await main();
process.exit(0);
