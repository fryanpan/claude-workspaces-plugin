#!/usr/bin/env bun
/**
 * A reviewer commenting on a chart label, driven with real presses.
 *
 * Spawned by `widget-post-click.test.ts`, which reads the JSON it prints. It
 * lives in its own process because the browser lifecycle does — one launch, a
 * throwaway profile, and a cleanup that has to run even when a case throws —
 * and because the presses have to be REAL. `bun run ui:shot --eval-file`
 * evaluates script in the page, and script cannot dispatch a trusted press:
 * the whole of this bug is about which listener sees a press first, so a
 * `dispatchEvent` would be testing the test. `Input.dispatchMouseEvent` over
 * CDP is a press the browser itself routes.
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

/** The widget's own tag, as the page and the driver both address it. */
const TAG = 'claude-feedback-widget';
const SHADOW = `document.querySelector('${TAG}').shadowRoot`;

/** One page load driven end to end. */
export interface Case {
  width: number;
  height: number;
  /**
   * Give the page a viewport hit test that does NOT retarget shadow content
   * to the host — the engine behaviour the fix stops relying on. With it on,
   * `document.elementFromPoint` over the composer answers with the inner
   * shadow node (the Post button itself) rather than with
   * `<claude-feedback-widget>`.
   */
  pierce: boolean;
}

/** What one control of the widget's own did when it was pressed. */
export interface PressReading {
  /** The composer's quoted subject, or null when no composer is open. */
  snippet: string | null;
  /** Where the composer sits, so a stray one can be placed. */
  left: string | null;
  top: string | null;
  /** Comments posted so far, oldest first. */
  posts: Array<{ snippet: string | null; text: string }>;
  /** Is feedback mode still armed? */
  mode: boolean;
}

export interface Reading {
  width: number;
  pierce: boolean;
  /** The FAB armed the mode — the control for everything after it. */
  armed: boolean;
  /** A press on the page still picks the element under it. */
  firstAnchor: string | null;
  /** The draft survived being re-anchored onto a second element. */
  carried: string | null;
  secondAnchor: string | null;
  /** Pressing Post. */
  afterPost: PressReading;
  /** Pressing Cancel, on a composer opened on a third label. */
  thirdAnchor: string | null;
  afterCancel: PressReading;
  /** Pressing the banner's Done. */
  afterDone: PressReading;
}

/* ===== the page under the reviewer ===== */

/**
 * The conditions the bug was reported under: a big single-file report drawn
 * by JavaScript, with SVG charts whose labels are real `<text>` nodes — the
 * elements the reporter was anchoring comments on.
 */
function reportHtml(bundle: string, pierce: boolean): string {
  const render = `
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function chart(i){
  const g=[];
  for(let b=0;b<12;b++){
    const h=20+((i*7+b*13)%120);
    g.push('<rect x="'+(40+b*54)+'" y="'+(180-h)+'" width="36" height="'+h+'" fill="#4a7fb5"></rect>');
    g.push('<text x="'+(58+b*54)+'" y="196" font-size="11" text-anchor="middle">'+MONTHS[b]+'</text>');
  }
  return '<section class="panel"><h2>Series '+i+'</h2>'+
    '<p>'+'Narrative paragraph for series '+i+'. '.repeat(10)+'</p>'+
    '<svg width="700" height="210" viewBox="0 0 700 210">'+g.join('')+'</svg></section>';
}
const parts=[]; for(let i=0;i<40;i++) parts.push(chart(i));
document.getElementById('report').innerHTML = parts.join('');`;

  // A hit test that hands back the inner shadow node. Installed BEFORE the
  // widget loads, so the widget only ever sees this one.
  const pierceScript = `
const real = document.elementFromPoint.bind(document);
document.elementFromPoint = (x, y) => {
  const host = document.querySelector('${TAG}');
  const sr = host && host.shadowRoot;
  const inner = sr ? sr.elementFromPoint(x, y) : null;
  return inner && inner.getRootNode() === sr ? inner : real(x, y);
};`;

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font:14px/1.5 system-ui;margin:0;padding:24px}
 .panel{border:1px solid #ddd;border-radius:8px;padding:16px;margin:0 0 24px}
 h2{margin:0 0 8px;font-size:15px}
 svg{max-width:100%;height:auto}
</style></head>
<body>
<h1>Quarterly report</h1>
<main id="report"></main>
<script>${pierce ? pierceScript : ''}</script>
<script>${render}</script>
<${TAG} doc-id="post-click" workspace-id="w-demo" user="Test Reviewer" server-url="ws://127.0.0.1:1"></${TAG}>
<script>${bundle}</script>
<script>
// The socket is deliberately unreachable: this is about which press opens
// what, not about the wire. Posting reports itself instead.
window.__posts = [];
const w = document.querySelector('${TAG}');
w.postNewThread = async (anchor, text) => {
  window.__posts.push({ snippet: anchor.snippet ? anchor.snippet.text : null, text });
  return true;
};
w.postReply = async (id, text) => { window.__posts.push({ snippet: null, text }); return true; };
</script>
</body></html>`;
}

/** Bundle the widget the way a host page loads it. */
function buildWidget(dir: string): string {
  const entry = join(dir, 'entry.ts');
  writeFileSync(
    entry,
    `import ${JSON.stringify(join(import.meta.dirname, '../src/widget.ts'))};\n`,
  );
  const built = spawnSync('bun', ['build', entry, '--target=browser'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr}`);
  return built.stdout;
}

/* ===== driving it ===== */

async function drive(cdp: Cdp, dir: string, bundle: string, c: Case): Promise<Reading> {
  const html = join(dir, `report-${c.width}-${c.pierce ? 'pierce' : 'plain'}.html`);
  writeFileSync(html, reportHtml(bundle, c.pierce));
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: c.width,
    height: c.height,
    deviceScaleFactor: 1,
    mobile: c.width <= 1100,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `file://${html}` });
  await loaded;
  await sleep(600);

  const at = async (expr: string): Promise<{ x: number; y: number } | null> =>
    (await cdp.evaluate(`(() => { const e = ${expr}; if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`)) as never;

  const press = async (p: { x: number; y: number } | null, what: string): Promise<void> => {
    if (!p) throw new Error(`nothing to press for ${what}`);
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await cdp.send('Input.dispatchMouseEvent', {
        type,
        x: p.x,
        y: p.y,
        button: 'left',
        clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0,
        pointerType: 'mouse',
      });
      await sleep(30);
    }
    await sleep(180);
  };

  /**
   * What the open composer is about, or null when none is open.
   *
   * The card in the margin quotes it; the phone panel does not (one row, by
   * the owner's call of 2026-09-11), so the picker's own outline is what names
   * the subject there — and it is read from the widget's chrome as well as the
   * page, because "the composer opened about the Post button" is exactly the
   * fingerprint these cases exist to catch.
   */
  const SUBJECT = `(() => {
      const sr = ${SHADOW};
      if (!sr.querySelector('.composer')) return null;
      const quote = sr.querySelector('.composer-snippet');
      if (quote) return quote.textContent;
      const lit = (root) => [...root.querySelectorAll('*')].find((e) => /solid/.test(e.style.outline));
      const o = lit(document) ?? lit(sr);
      return o ? (o.textContent ?? '').trim().slice(0, 40) : null;
    })()`;
  const snippet = (): Promise<string | null> => cdp.evaluate(SUBJECT) as Promise<string | null>;
  const reading = (): Promise<PressReading> =>
    cdp.evaluate(`({
      snippet: ${SUBJECT},
      left: ${SHADOW}.querySelector('.composer')?.style.left ?? null,
      top: ${SHADOW}.querySelector('.composer')?.style.top ?? null,
      posts: window.__posts,
      mode: document.querySelector('${TAG}').feedbackMode,
    })`) as Promise<PressReading>;

  /** The nth chart label that is fully on screen, clear of the composer. */
  const label = (n: number): Promise<{ x: number; y: number } | null> =>
    at(`[...document.querySelectorAll('svg text')].filter(t => {
          const r = t.getBoundingClientRect();
          return r.top > 140 && r.bottom < innerHeight - 320 && r.width > 8;
        })[${n}]`);

  await press(await at(`${SHADOW}.querySelector('.fab')`), 'the FAB');
  const armed = (await cdp.evaluate(`document.querySelector('${TAG}').feedbackMode`)) as boolean;

  // A press on the page picks the element under it, and a draft moves with
  // you onto the next one.
  await press(await label(0), 'the first label');
  const firstAnchor = await snippet();
  await cdp.send('Input.insertText', { text: 'this label' });
  await press(await label(4), 'the second label');
  const carried = (await cdp.evaluate(
    `${SHADOW}.querySelector('.composer textarea')?.value ?? null`,
  )) as string | null;
  const secondAnchor = await snippet();

  await cdp.send('Input.insertText', { text: ' is wrong' });
  await press(await at(`${SHADOW}.querySelector('.composer .submit')`), 'Post');
  const afterPost = await reading();

  // Cancel, on a composer opened over a third label.
  await press(await label(8), 'the third label');
  const thirdAnchor = await snippet();
  await press(await at(`${SHADOW}.querySelector('.composer .cancel')`), 'Cancel');
  const afterCancel = await reading();

  await press(await at(`${SHADOW}.querySelector('.picker-cancel')`), "the banner's Done");
  const afterDone = await reading();

  return {
    width: c.width,
    pierce: c.pierce,
    armed,
    firstAnchor,
    carried,
    secondAnchor,
    afterPost,
    thirdAnchor,
    afterCancel,
    afterDone,
  };
}

/* ===== the run ===== */

const CASES: readonly Case[] = [
  { width: 1180, height: 820, pierce: false },
  { width: 1180, height: 820, pierce: true },
  { width: 430, height: 932, pierce: false },
  { width: 430, height: 932, pierce: true },
];

const runId = `postclick${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-post-click-'));
let browser: Browser | undefined;
const stop = (proc: ChildProcess | undefined): void => {
  try {
    proc?.kill();
  } catch {}
};
try {
  const bundle = buildWidget(dir);
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
  for (const c of CASES) readings.push(await drive(cdp, dir, bundle, c));
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
