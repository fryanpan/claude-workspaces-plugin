#!/usr/bin/env bun
/**
 * Opening, replying to and closing a doc comment by touch, in headless
 * Chromium against a real server and the real doc bundle.
 *
 * A plan with four commented sentences is opened at 430x932, where each
 * comment is an inline card under its words, and at 1180x820, where it is a
 * balloon in the margin. Taps are touch events. Both pages also get an
 * on-screen keyboard the way iOS presents one: the layout viewport keeps its
 * height and `visualViewport` loses the keyboard's while a text entry holds
 * focus. Chromium has no keyboard of its own, so without this nothing on the
 * page would ever have a reason to scroll.
 *
 * Each step is read once the page has settled, so a failure names its step.
 * Spawned by `mobile-comment-tap-browser.test.ts`, which reads the JSON it
 * prints. `MOBILE_COMMENT_SHOTS=<dir>` also writes a screenshot per step.
 * `MOBILE_COMMENT_APP=<dir>` builds the doc bundle from another checkout's
 * `packages/workspaces-app`, which is how the positive control runs.
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
import type { MobileCommentRun, TapView } from './mobile-comment-tap-browser-reading.ts';

const FILLER =
  'The Riverbend crossing carries commuters at dawn and freight at noon, and the ' +
  'Saltmarsh tide table decides which of the two slipways can take a loaded ferry.';
const NEEDLES = ['first berth', 'second berth', 'third berth', 'fourth berth'];
const PLAN = [
  '# Harborlight ferry plan\n',
  ...NEEDLES.flatMap((n) => [
    `${FILLER} ${FILLER}\n`,
    `${FILLER} The ${n} opens in spring.\n`,
    `${FILLER} ${FILLER}\n`,
  ]),
].join('\n');
/** Long enough to wrap the reply box onto a third line at 430. */
const TYPED =
  'Alice signs off the berth once the Saltmarsh survey is back and the tide table agrees.';

/** About an iPhone's keyboard. */
const KEYBOARD_PX = 336;

const step = (what: string): void => {
  process.stderr.write(`[mobile-comment-driver] ${what}\n`);
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

/** The keyboard, installed before the app boots so its listeners attach to
 *  this object rather than the real one. */
const KEYBOARD = `(() => {
  const vv = new EventTarget();
  let kb = 0;
  const g = (f) => ({ get: f, configurable: true });
  Object.defineProperties(vv, {
    height: g(() => innerHeight - kb), width: g(() => innerWidth),
    offsetTop: g(() => 0), offsetLeft: g(() => 0), scale: g(() => 1),
    pageTop: g(() => scrollY), pageLeft: g(() => scrollX),
  });
  Object.defineProperty(window, 'visualViewport', g(() => vv));
  const entry = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
  const sync = () => {
    const want = entry(document.activeElement) ? ${KEYBOARD_PX} : 0;
    if (want === kb) return;
    kb = want;
    vv.dispatchEvent(new Event('resize'));
  };
  document.addEventListener('focusin', () => setTimeout(sync, 30), true);
  document.addEventListener('focusout', () => setTimeout(sync, 30), true);
})()`;

/** The page-side helpers: which card is under test, and one reading. */
const HELPERS = (cardSelector: string, index: number) => `(() => {
  window.__card = () => document.querySelectorAll(${JSON.stringify(cardSelector)})[${index}];
  window.__view = () => {
    const ed = document.querySelector('#editor');
    const card = __card();
    const box = card.querySelector('.thread-reply .md-composer-surface .ProseMirror');
    const reply = box && box.getClientRects().length ? box.getBoundingClientRect() : null;
    const edBox = ed.getBoundingClientRect();
    const a = document.activeElement;
    const docEditor = document.querySelector('#editor .ProseMirror');
    return {
      scrollTop: Math.round(ed.scrollTop),
      expanded: card.classList.contains('expanded'),
      cardTop: Math.round(card.getBoundingClientRect().top),
      replyTop: reply ? Math.round(reply.top) : null,
      replyBottom: reply ? Math.round(reply.bottom) : null,
      bandTop: Math.round(edBox.top),
      bandBottom: Math.round(Math.min(edBox.bottom, visualViewport.height)),
      keyboard: Math.round(innerHeight - visualViewport.height),
      focus: box && a === box ? 'reply' : a === docEditor ? 'doc' : 'other',
      replyText: box ? box.textContent : '',
    };
  };
  window.__settled = async () => {
    // Settled: no animation running, and the scroller still across a frame.
    for (;;) {
      const moving = document.getAnimations().some((x) => x.playState === 'running');
      const before = document.querySelector('#editor').scrollTop;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (!moving && document.querySelector('#editor').scrollTop === before) return true;
    }
  };
  return true;
})()`;

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

interface Page {
  cdp: Cdp;
  settle: () => Promise<TapView>;
  /** Tap the card, or one part of it, with a finger. `y` overrides where. */
  tap: (sel: string | null, y?: number) => Promise<void>;
  shot: (name: string) => Promise<void>;
}

async function openPage(
  url: string,
  width: number,
  height: number,
  cardSelector: string,
  index: number,
): Promise<Page> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile),
    STARTUP_TIMEOUT_MS,
    `mobile-comment-${width}-${process.pid}`,
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
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // A returning reader: a first arrival gets the name prompt over the doc.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Bob'); } catch {}`,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: KEYBOARD });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  // Every card, each with its reply editor mounted (the composer chunk is lazy).
  await until('four comment cards', async () =>
    Number(
      await cdp.evaluate(
        `[...document.querySelectorAll(${JSON.stringify(cardSelector)})].filter((c) => c.querySelector('.md-composer-surface .ProseMirror')).length`,
      ),
    ) >= NEEDLES.length
      ? true
      : null,
  );
  await cdp.evaluate(HELPERS(cardSelector, index));
  const shots = process.env.MOBILE_COMMENT_SHOTS;
  return {
    cdp,
    settle: async () => {
      await cdp.evaluate('__settled()');
      return (await cdp.evaluate('__view()')) as TapView;
    },
    tap: async (sel, y) => {
      const at = (await cdp.evaluate(`(() => {
        const card = __card();
        const el = ${sel ? `card.querySelector(${JSON.stringify(sel)})` : 'card'};
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: ${y ?? 'r.top + Math.min(r.height / 2, 12)'} };
      })()`)) as { x: number; y: number };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    shot: async (name) => {
      if (!shots) return;
      const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
        data: string;
      };
      writeFileSync(join(shots, `${name}-${width}.png`), Buffer.from(png.data, 'base64'));
    },
  };
}

/** Put the card's top `offset` pixels below the editor's top edge. */
const scrollCardTo = (offset: number) => `(() => {
  const ed = document.querySelector('#editor');
  ed.scrollTop += __card().getBoundingClientRect().top - ed.getBoundingClientRect().top - ${offset};
  return true;
})()`;

/**
 * The fixed wait after a close is the assertion, not a delay: closing must
 * move nothing, and `edit-viewport.ts` follows a newly focused caret on a
 * 500ms fallback timer when no keyboard resize arrives. Reading sooner would
 * pass a page that jumps at 500ms.
 */
const PAST_FOLLOW_MS = 800;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-comment-'));
  const shots = process.env.MOBILE_COMMENT_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  let handle: ServerHandle | undefined;
  try {
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    step('build the doc bundle');
    const appPkg = process.env.MOBILE_COMMENT_APP ?? join(import.meta.dirname, '..');
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
    await fetch(`${base}/workspaces/${ws}/docs/${docId}`);
    const ydoc = await until('the doc in memory', () => server.docStore.get(docId)?.ydoc ?? null);
    // One thread per sentence, anchored exactly as the editor anchors one.
    for (const needle of NEEDLES) {
      const walk = prose.walkProse(prose.getProseFragment(ydoc));
      const at = walk.plainText.indexOf(needle);
      const seg = walk.segments.find((s) => at >= s.docOffset && at < s.docOffset + s.length);
      if (!seg) throw new Error(`no text segment holds "${needle}"`);
      const rel = (i: number) =>
        Array.from(
          Y.encodeRelativePosition(
            Y.createRelativePositionFromTypeIndex(seg.node, i - seg.docOffset),
          ),
        );
      await post(`/workspaces/${ws}/docs/${docId}/threads`, {
        author: { id: 'known-alice', name: 'Alice', color: '#3366cc' },
        text: `Who signs off the ${needle}? ${FILLER}`,
        anchor: {
          kind: 'text-range',
          startRel: rel(at),
          endRel: rel(at + needle.length),
          snippet: { text: needle },
        },
      });
    }
    const docMarkdown = () => prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
    const url = `${base}/workspaces/${ws}/docs/${docId}`;

    step('430x932: open, type into and close an inline card');
    const phone = await openPage(url, 430, 932, '#editor .cw-inline-card', 1);
    await phone.cdp.evaluate(scrollCardTo(300));
    const openBefore = await phone.settle();
    await phone.tap('.face-summary');
    const openAfter = await phone.settle();
    await phone.shot('open');

    // One word at a time, the way a keyboard sends them. The first goes
    // wherever the tap left the caret; a word that lands in the document
    // reaches the server through the doc's own sync.
    const words = TYPED.split(' ');
    await phone.cdp.send('Input.insertText', { text: `${words[0]} ` });
    const typedIntoDoc = await until(
      'the first word in the document',
      () => (docMarkdown().includes(words[0] ?? '') ? true : null),
      1_000,
    ).catch(() => false);
    // Then the reader taps the reply box, as they must wherever the caret
    // went, and types the rest.
    await phone.tap('.thread-reply .md-composer-surface .ProseMirror');
    for (const word of words.slice(1)) {
      await phone.cdp.send('Input.insertText', { text: `${word} ` });
    }
    const typed = await phone.settle();
    await phone.shot('typed');

    // The reader scrolls on, leaving the open card's head near the top and
    // its words above the screen, then taps the head to close it.
    await phone.cdp.evaluate(scrollCardTo(20));
    const closeBefore = await phone.settle();
    await phone.tap('.thread-head');
    await sleep(PAST_FOLLOW_MS);
    const closeAfter = await phone.settle();
    await phone.shot('closed');

    // The same card, folded, with its top above the editor: tap its foot.
    await phone.cdp.evaluate(scrollCardTo(-40));
    const belowBefore = await phone.settle();
    await phone.tap(null, belowBefore.bandTop + 30);
    const belowAfter = await phone.settle();
    phone.cdp.close();

    step('1180x820: open and close a margin balloon');
    const wide = await openPage(url, 1180, 820, '.markup-margin .thread', 1);
    await wide.cdp.evaluate(scrollCardTo(200));
    const wOpenBefore = await wide.settle();
    await wide.tap('.face-summary');
    const wOpenAfter = await wide.settle();
    await wide.shot('open');
    await wide.tap('.thread-head');
    await sleep(PAST_FOLLOW_MS);
    const wCloseAfter = await wide.settle();
    wide.cdp.close();

    const run: MobileCommentRun = {
      phone: {
        open: { before: openBefore, after: openAfter },
        openFromBelow: { before: belowBefore, after: belowAfter },
        typed,
        typedIntoDoc,
        close: { before: closeBefore, after: closeAfter },
      },
      wide: {
        open: { before: wOpenBefore, after: wOpenAfter },
        close: { before: wOpenAfter, after: wCloseAfter },
      },
    };
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
