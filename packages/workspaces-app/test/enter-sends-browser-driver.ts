#!/usr/bin/env bun
/**
 * Types into three real comment boxes in headless Chrome and presses the keys
 * a reader presses: Shift+Enter, an IME's committing Enter, Enter, Enter in
 * the emptied box, and Cmd+Enter. Prints one JSON reading per box.
 *
 * Every key is a CDP keystroke, so it reaches the markdown editor that sits
 * over the textarea exactly as a person's does — a synthetic `KeyboardEvent`
 * on the textarea would skip the editor's re-dispatch, which is the path the
 * task box was missing.
 *
 * Run by `enter-sends-browser.test.ts`; a separate Bun process for the reason
 * `math-browser-driver.ts` gives.
 */
import { join } from 'node:path';
import {
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
  stopBrowser,
  withTimeout,
} from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
  resolveRunId,
} from '../../../scripts/ui-shot-lib.ts';
import type { BoxRun, EnterReading, Kind } from './enter-sends-browser-page.ts';

const pkg = join(import.meta.dir, '..');
const KINDS: Kind[] = ['task', 'card', 'widget'];

async function bundle(entry: string): Promise<string> {
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  if (!built.success) throw new Error(built.logs.map(String).join('\n'));
  return (await built.outputs[0]?.text()) ?? '';
}

async function poll<T>(read: () => Promise<T | null>, what: string, tries = 300): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await read();
    if (v !== null) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A send that may not come: on a box that never sends this is the failure
 *  being measured, so it gives up after 3s and the reading says so. */
const sendLanded = (read: () => Promise<boolean>): Promise<boolean> =>
  poll(async () => ((await read()) ? true : null), 'a send', 60).catch(() => false);

/** CDP's modifier bits. */
const SHIFT = 8;
const META = 4;

const page = await bundle(join(import.meta.dir, 'enter-sends-browser-page.ts'));
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/page.js') {
      return new Response(page, { headers: { 'content-type': 'text/javascript' } });
    }
    for (const sheet of ['board.css', 'styles.css', 'doc.css']) {
      if (path === `/${sheet}`) return new Response(Bun.file(join(pkg, 'src', sheet)));
    }
    return new Response(
      `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/board.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/doc.css"><body class="board-body"><script type="module" src="/page.js"></script></body>`,
      { headers: { 'content-type': 'text/html' } },
    );
  },
});
const origin = `http://127.0.0.1:${server.port}`;
let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
let cdp: Cdp | undefined;
const runs: BoxRun[] = [];
try {
  browser = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
    STARTUP_TIMEOUT_MS,
    `${resolveRunId()}enter`,
    (b) => {
      browser = b;
    },
  );
  const c = await Cdp.connect(await pageSocketUrl(browser.port, STARTUP_TIMEOUT_MS));
  cdp = c;
  await c.send('Page.enable');
  const loaded = c.once('Page.loadEventFired');
  await c.send('Page.navigate', { url: origin });
  await withTimeout(loaded, 20_000, 'page load');
  await poll(
    async () => ((await c.evaluate('typeof window.cwEnter')) === 'object' ? true : null),
    'the page bundle',
  );

  const read = async (): Promise<EnterReading> =>
    (await c.evaluate('window.cwEnter.read()')) as EnterReading;
  /** Two frames: the browser's turn to apply a key nothing consumed. */
  const settle = (): Promise<unknown> =>
    c.evaluate(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))',
    );
  const enter = async (modifiers: number, keyCode = 13): Promise<void> => {
    const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: keyCode, modifiers };
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k, text: '\r' });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  };
  const type = async (text: string): Promise<void> => {
    await c.send('Input.insertText', { text });
    await poll(async () => ((await read()).value.includes(text) ? true : null), `"${text}" typed`);
  };

  for (const kind of KINDS) {
    const sel = (await c.evaluate(`window.cwEnter.mount(${JSON.stringify(kind)})`)) as string;
    await poll(
      async () =>
        (await c.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return null;
          el.focus();
          return document.activeElement === el ? true : null;
        })()`)) as true | null,
      `${kind}: a focused box`,
    );

    await type('one');
    await enter(SHIFT);
    await type('two');
    const afterShiftEnter = await read();

    await enter(0, 229);
    await settle();
    const afterSafariIme = await read();

    await c.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
    await enter(0, 229);
    await c.send('Input.insertText', { text: 'に' });
    await settle();
    const afterChromeIme = await read();

    await enter(0);
    await sendLanded(async () => (await read()).sent.length > 0);
    const afterEnter = await read();

    await enter(0);
    await settle();
    const afterEmptyEnter = await read();

    await type('three');
    await enter(META);
    const before = (await read()).sent.length;
    await sendLanded(async () => (await read()).sent.length > before);
    const afterCmdEnter = await read();

    runs.push({
      kind,
      afterShiftEnter,
      afterSafariIme,
      afterChromeIme,
      afterEnter,
      afterEmptyEnter,
      afterCmdEnter,
    });
  }
} finally {
  cdp?.close();
  if (browser) await stopBrowser(browser.proc, browser.profile);
  server.stop(true);
}
process.stdout.write(`${JSON.stringify(runs)}\n`);
process.exit(0);
