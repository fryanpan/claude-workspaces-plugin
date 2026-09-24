#!/usr/bin/env bun
/**
 * A page a reader keeps using while they talk, in a running browser.
 *
 * While voice records, a click, a key and an Escape must reach the page, and
 * only a tap after Move is the widget's. happy-dom dispatches synthetic
 * events straight at a node, so it cannot say whether a real click still
 * runs a button's handler or whether typed keys land in a focused input.
 * This loads the real widget with the real voice mode on a small page, drives
 * it with CDP input events, and reports what the page and the voice socket
 * saw. The socket and the microphone are the unit tests' stand-ins
 * (`voice-fakes.ts`), so the server's side is scripted from the page.
 *
 * Twice: at 1180x820 with a mouse, and at 430x932 with touch taps, because
 * the owner reviews on an iPad. The hover outline is read on the mouse run
 * only; a finger has no hover.
 *
 * Spawned by `voice-passthrough-browser.test.ts`, which reads the JSON it
 * prints. Its own process for the reason `mic-phone-driver.ts` gives: one
 * browser launch, with a cleanup that must run even when a case throws.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was measured in a running browser.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Browser,
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
} from '../../../scripts/headless-chrome.ts';
import { chromeLaunchArgs, profilesOfRun, resolveChromeBin } from '../../../scripts/ui-shot-lib.ts';

const TAG = 'claude-feedback-widget';
const SHADOW = `document.querySelector('${TAG}').shadowRoot`;

export interface Reading {
  width: number;
  touch: boolean;
  /** A plain click while recording: the button's own handler ran this often. */
  savedByPlainClick: number;
  /** ...and the pin frames the socket was sent. */
  pinsAfterPlainClick: number;
  /** What typing "Riverbend" into the page's input left in it. */
  typed: string;
  /** Escape while recording, with no Move armed: seen by the page, and not prevented. */
  escapeToPage: boolean;
  stateAfterEscape: string;
  /** The hover outline over a page element, before Move / while armed / after the move. Null on touch. */
  outlineRecording: boolean | null;
  outlineArmed: boolean | null;
  outlineAfterMove: boolean | null;
  /** Move was armed by its button. */
  armed: boolean;
  /** The tap after Move: the button's handler ran this many times in total, still. */
  savedAfterMoveTap: number;
  /** The move frame the tap sent, and the catalog index of the tapped element. */
  moveTarget: number | null;
  saveIndex: number | null;
  /** Escape while Move is armed: prevented, and Move disarmed. */
  escapeCancelPrevented: boolean;
  pickingAfterEscape: string | null;
}

function pageHtml(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font:15px/1.5 system-ui;margin:0;background:#f7f7f2}
 main{padding:24px}
 button,input{font:inherit;padding:10px 14px}
 #title{margin:0 0 16px}
</style></head>
<body>
<main>
 <h1 id="title">Harborlight open day</h1>
 <p><button id="save" onclick="window.__saved++">Save</button></p>
 <p><input id="name" placeholder="Name"></p>
</main>
<${TAG} doc-id="d-1" workspace-id="w-1" user="Alice" server-url="ws://127.0.0.1:1"></${TAG}>
<script>
window.__saved = 0;
window.__keys = [];
document.addEventListener('keydown', (e) => window.__keys.push([e.key, e.defaultPrevented]));
// The thread routes: a voice comment posts through fetch.
const real = window.fetch;
window.fetch = (url, init) =>
  init && init.method === 'POST'
    ? Promise.resolve(new Response(JSON.stringify({ thread: { id: 't1', comments: [{ id: 'c1' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } }))
    : real(url, init);
</script>
<script>${bundle}</script>
</body></html>`;
}

/** The widget, its mic and voice mode on stand-in socket and microphone, in one bundle. */
function buildPage(dir: string): string {
  const entry = join(dir, 'entry.ts');
  const src = (f: string) => JSON.stringify(join(import.meta.dirname, '../src', f));
  const fakes = JSON.stringify(join(import.meta.dirname, 'voice-fakes.ts'));
  writeFileSync(
    entry,
    `import ${src('widget.ts')};
import { addMic } from ${src('widget-mic.ts')};
import { mountVoiceMode } from ${src('voice/voice-mode.ts')};
import { FakeSocket, fakeMic } from ${fakes};
const host = document.querySelector('${TAG}') as never;
const mic = fakeMic();
let socket: FakeSocket | null = null;
const mode = mountVoiceMode(host, addMic(host, { comment: 'Type', voice: 'Talk', history: 'Past', icon: '' }), {
  openSocket: (u) => (socket = new FakeSocket(u)),
  startCapture: mic.start,
  shown: () => true,
});
(globalThis as unknown as { __v: unknown }).__v = { mode, mic, socket: () => socket };
`,
  );
  const built = spawnSync('bun', ['build', entry, '--target=browser'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr}`);
  return built.stdout;
}

/** The outline voice mode draws on hover: the second `.vhl` in the shadow
 *  root, after the one VoiceView makes for the attached element. */
const OUTLINE = `(() => {
  const hl = [...${SHADOW}.children].filter((e) => e.classList.contains('vhl'))[1];
  return !!hl && !hl.hidden;
})()`;

async function poll(cdp: Cdp, expr: string, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await cdp.evaluate(expr)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function drive(cdp: Cdp, dir: string, bundle: string, width: number, height: number) {
  const touch = width <= 1100;
  const html = join(dir, `page-${width}.html`);
  writeFileSync(html, pageHtml(bundle));
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: touch,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 5 });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `file://${html}` });
  await loaded;
  await poll(cdp, 'typeof window.__v === "object"', 'voice mode to mount');

  const centre = async (expr: string): Promise<{ x: number; y: number }> => {
    const p = (await cdp.evaluate(`(() => { const e = ${expr}; if (!e) return null;
      const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`)) as {
      x: number;
      y: number;
    } | null;
    if (!p) throw new Error(`nothing at ${expr}`);
    return p;
  };
  const tap = async (expr: string): Promise<void> => {
    const p = await centre(expr);
    if (touch) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
      }
    }
    await sleep(150);
  };
  const hover = async (expr: string): Promise<boolean | null> => {
    if (touch) return null;
    const p = await centre(expr);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, pointerType: 'mouse' });
    await sleep(100);
    return (await cdp.evaluate(OUTLINE)) as boolean;
  };
  const key = async (k: string, code: string, text?: string): Promise<void> => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code });
  };
  const frames = (type: string) => `window.__v.socket().json().filter((m) => m.type === '${type}')`;
  const byId = (id: string) => `document.getElementById('${id}')`;

  // Recording, with the server's engine up.
  await cdp.evaluate('window.__v.mode.toggle()');
  await cdp.evaluate(
    `(() => { const s = window.__v.socket(); s.open(); s.recv({ type: 'ready', segment: 1 }); })()`,
  );
  await poll(cdp, 'window.__v.mic.opts !== null', 'the microphone to open');

  const outlineRecording = await hover(byId('save'));
  await tap(byId('save'));
  const savedByPlainClick = (await cdp.evaluate('window.__saved')) as number;
  const pinsAfterPlainClick = (await cdp.evaluate(`${frames('pin')}.length`)) as number;

  await tap(byId('name'));
  for (const ch of 'Riverbend') await key(ch, `Key${ch.toUpperCase()}`, ch);
  const typed = (await cdp.evaluate(`${byId('name')}.value`)) as string;

  await key('Escape', 'Escape');
  const escapeToPage = (await cdp.evaluate(
    `window.__keys.some(([k, prevented]) => k === 'Escape' && !prevented)`,
  )) as boolean;
  const stateAfterEscape = (await cdp.evaluate('window.__v.mode.session.state')) as string;

  const indexOf = (id: string) =>
    `${frames('start')}[0].targets.find((t) => (t.hint || '').split(' ').includes('#${id}'))?.i ?? null`;
  // A comment the server placed on the heading, then Move on its card. (A
  // comment on the page as a whole shows no Move.)
  await cdp.evaluate(`window.__v.socket().recv({ type: 'comment', key: 'v1', text: 'the Save button is too small',
    raw: 'the Save button is too small', clip: '/workspaces/w-1/docs/d-1/voice-feedback/seg-1.wav#t=2,9',
    target: ${indexOf('title')}, final: false })`);
  await poll(
    cdp,
    `!!window.__v.mode.session.comments.get('1.v1')?.posted`,
    'the comment to be posted',
  );
  const move = `${SHADOW}.querySelector('.vlive .vmove')`;
  await tap(move);
  const armed = (await cdp.evaluate('window.__v.mode.view.picking')) === '1.v1';
  const outlineArmed = await hover(byId('title'));
  await tap(byId('save'));
  const savedAfterMoveTap = (await cdp.evaluate('window.__saved')) as number;
  const moveTarget = (await cdp.evaluate(`${frames('move')}.at(-1)?.target ?? null`)) as
    | number
    | null;
  const saveIndex = (await cdp.evaluate(indexOf('save'))) as number | null;
  const outlineAfterMove = await hover(byId('title'));

  await tap(move);
  await cdp.evaluate('window.__keys.length = 0');
  await key('Escape', 'Escape');
  const escapeCancelPrevented = (await cdp.evaluate(
    `window.__keys.some(([k, prevented]) => k === 'Escape' && prevented)`,
  )) as boolean;
  const pickingAfterEscape = (await cdp.evaluate('window.__v.mode.view.picking')) as string | null;

  const reading: Reading = {
    width,
    touch,
    savedByPlainClick,
    pinsAfterPlainClick,
    typed,
    escapeToPage,
    stateAfterEscape,
    outlineRecording,
    outlineArmed,
    outlineAfterMove,
    armed,
    savedAfterMoveTap,
    moveTarget,
    saveIndex,
    escapeCancelPrevented,
    pickingAfterEscape,
  };
  return reading;
}

const runId = `voicepass${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-voice-pass-'));
let browser: Browser | undefined;
const stop = (proc: ChildProcess | undefined): void => {
  try {
    proc?.kill();
  } catch {}
};
try {
  const bundle = buildPage(dir);
  browser = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
    60_000,
    runId,
    (b) => {
      browser = b;
    },
  );
  const cdp = await Cdp.connect(await pageSocketUrl(browser.port, 30_000));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const readings: Reading[] = [];
  readings.push(await drive(cdp, dir, bundle, 1180, 820));
  readings.push(await drive(cdp, dir, bundle, 430, 932));
  cdp.close();
  console.log(JSON.stringify(readings));
} finally {
  stop(browser?.proc);
  await sleep(400);
  rmSync(dir, { recursive: true, force: true });
  for (const name of profilesOfRun(readdirSync(tmpdir()), runId)) {
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    } catch {}
  }
}
process.exit(0);
