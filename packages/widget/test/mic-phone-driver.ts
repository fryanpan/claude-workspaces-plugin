#!/usr/bin/env bun
/**
 * The mic a host hangs on the widget, measured in a running browser.
 *
 * Two things about it are pure layout, so happy-dom (which does no layout at
 * all) cannot see either:
 *
 * - Whether the mic is still PAINTED once the phone face folds the floating
 *   buttons under the bottom panel. The fold is a `:has()` rule, and the mic
 *   wears `.fab-list` for its look and its place, so it was folding away with
 *   the thread list and comment mode had no mic at all at phone width.
 * - Where the hover label lands. It is an `::after` on the button, pushed left
 *   of it; long labels ran off the left edge of a 430-wide screen entirely.
 *   A pseudo-element has no node to measure, so its box is reconstructed from
 *   the used values the browser resolves for it — which is still a
 *   measurement of what was painted, not a reading of the stylesheet.
 *
 * Spawned by `widget-mic-phone.test.ts`, which reads the JSON it prints. Its
 * own process for the reason `comment-layout-driver.ts` gives: one browser
 * launch, with a cleanup that must run even when a case throws.
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

/**
 * Hover labels the length a host really gives: the board says, on all three
 * buttons, that the feedback is about the app rather than the project on
 * screen. The widget cannot shorten what a host hands it, so the label has to
 * fit whatever arrives — which is what the left-edge case is about.
 */
const LABELS = {
  comment: 'Feedback on the Workspaces app, not this project — click anything',
  voice: 'Voice feedback on the Workspaces app, not this project — hold to talk',
  history: 'Feedback on the Workspaces app, not this project — what has been said so far',
  icon: '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
};

/** [left, top, right, bottom], rounded. */
export type Box = [number, number, number, number];

/** A hover label's own box, rebuilt from the used values of its `::after`. */
export interface Tip {
  /** The words the label is showing, or null when nothing is painted. */
  text: string | null;
  box: Box | null;
}

export interface Look {
  mode: boolean;
  /** The mic, when it is painted. */
  mic: Box | null;
  /** The thread list, which folds away in the mode. */
  list: Box | null;
  fab: Box | null;
  /** The bottom panel: the mode's prompt, or the composer that replaces it. */
  panel: Box | null;
  composer: Box | null;
  /** The composer's one line of news, when it has any to give. */
  note: string | null;
}

export interface Reading {
  width: number;
  height: number;
  looks: Record<string, Look>;
  /** One reading per button, taken with the pointer resting on it, before
   *  comment mode starts — when all three buttons are on screen. */
  tips: Record<string, Tip>;
  /** The same, in comment mode: the two buttons that stay. */
  tipsInMode: Record<string, Tip>;
  /** The mic's hover label is drawn, with no note beside the mic. */
  micLabelNoNote: boolean;
  /** The same, with a note showing. */
  micLabelUnderNote: boolean;
}

function pageHtml(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font:15px/1.5 system-ui;margin:0;background:#f7f7f2}
 header{background:#2f6b3a;color:#fff;padding:18px 24px}
 h1{margin:0;font-size:22px}
 main{padding:24px}
 #narrow{width:200px;height:70px;background:#eef5ea}
 #tail{height:900px}
</style></head>
<body>
<header><h1 id="title">Harborlight open day</h1></header>
<main>
 <div id="narrow">Ferry times<br>Six sailings</div>
 <div id="tail"></div>
</main>
<${TAG} doc-id="mic-phone" workspace-id="w-demo" user="Test Reviewer" server-url="ws://127.0.0.1:1"></${TAG}>
<script>${bundle}</script>
<script>
const host = document.querySelector('${TAG}');
host.postNewThread = async () => !window.__refuse;
window.__cwAddMic(host, ${JSON.stringify(LABELS)});
// A workspace that wants a signature. The composer answers a refusal with a
// line of news and a Sign in button under its row, which is the TALLEST the
// bottom panel gets — and the height the mic above it has to clear.
window.__wantSignIn = () => {
  window.__refuse = true;
  host.signInToWrite = true;
};
</script>
</body></html>`;
}

/** The widget plus the mic entry the host mounts on it, in one bundle. */
function buildWidget(dir: string): string {
  const entry = join(dir, 'entry.ts');
  const widget = JSON.stringify(join(import.meta.dirname, '../src/widget.ts'));
  const mic = JSON.stringify(join(import.meta.dirname, '../src/widget-mic.ts'));
  writeFileSync(
    entry,
    `import ${widget};\nimport { addMic } from ${mic};\n` +
      '(globalThis as unknown as { __cwAddMic: unknown }).__cwAddMic = addMic;\n',
  );
  const built = spawnSync('bun', ['build', entry, '--target=browser'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr}`);
  return built.stdout;
}

const LOOK = `(() => {
  const sr = ${SHADOW};
  const host = document.querySelector('${TAG}');
  const box = (e) => {
    if (!e || getComputedStyle(e).display === 'none') return null;
    const r = e.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
  };
  return {
    mode: host.feedbackMode,
    mic: box(sr.querySelector('.fab-mic')),
    list: box(sr.querySelector('.fab-list:not(.fab-mic)')),
    fab: box(sr.querySelector('.fab')),
    panel: box(sr.querySelector('.picker-banner')),
    composer: box(sr.querySelector('.composer')),
    note: sr.querySelector('.composer-err')?.textContent ?? null,
  };
})()`;

/**
 * The hovered button's label, as a box on the screen.
 *
 * A pseudo-element is not a node, so there is nothing to call
 * `getBoundingClientRect()` on. What the browser will give up is the USED
 * value of every property it resolved for the thing it painted — so the box
 * is rebuilt from them: the label is absolutely positioned against the
 * button's padding box, and `right` is the offset from that box's right edge.
 *
 * `width` is the CONTENT width, so the padding and border are added back:
 * what runs off the screen is the painted box, and a label measured without
 * its 10px of side padding reads 20px narrower than the thing a reader sees.
 */
const tipOf = (selector: string): string => `(() => {
  const b = ${SHADOW}.querySelector(${JSON.stringify(selector)});
  if (!b) return { text: null, box: null };
  const after = getComputedStyle(b, '::after');
  if (!after.content || after.content === 'none') return { text: null, box: null };
  const r = b.getBoundingClientRect();
  const s = getComputedStyle(b);
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const sideways = after.boxSizing === 'border-box' ? 0
    : px(after.paddingLeft) + px(after.paddingRight) + px(after.borderLeftWidth) + px(after.borderRightWidth);
  const down = after.boxSizing === 'border-box' ? 0
    : px(after.paddingTop) + px(after.paddingBottom) + px(after.borderTopWidth) + px(after.borderBottomWidth);
  const w = parseFloat(after.width) + sideways;
  const h = parseFloat(after.height) + down;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return { text: null, box: null };
  const right = r.right - parseFloat(s.borderRightWidth) - parseFloat(after.right);
  const mid = r.top + r.height / 2;
  return {
    text: after.content.replace(/^"|"$/g, ''),
    box: [Math.round(right - w), Math.round(mid - h / 2), Math.round(right), Math.round(mid + h / 2)],
  };
})()`;

async function drive(cdp: Cdp, dir: string, bundle: string, width: number, height: number) {
  const html = join(dir, `page-${width}.html`);
  writeFileSync(html, pageHtml(bundle));
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `file://${html}` });
  await loaded;
  await sleep(500);

  const settle = () => sleep(250);
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
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
    await sleep(40);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle();
  };
  const hover = async (expr: string): Promise<void> => {
    const p = await centre(expr);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, pointerType: 'mouse' });
    await settle();
  };
  const looks: Record<string, Look> = {};
  const look = async (name: string): Promise<void> => {
    looks[name] = (await cdp.evaluate(LOOK)) as Look;
  };
  const BUTTONS = [
    ['voice', '.fab-mic'],
    ['comment', '.fab'],
    ['history', '.fab-list:not(.fab-mic)'],
  ] as const;
  /** The pointer, resting on each button in turn. A button that is not
   *  painted is not hovered — there is nothing under the pointer to label. */
  const offButtons = async (): Promise<void> => {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 4,
      y: height - 4,
      pointerType: 'mouse',
    });
    await settle();
  };
  const readTips = async (): Promise<Record<string, Tip>> => {
    const out: Record<string, Tip> = {};
    for (const [name, selector] of BUTTONS) {
      // From off the buttons each time: the history chip folds away while the
      // FAB's or the mic's label shows, so a pointer still resting on the FAB
      // would find no chip to hover.
      await offButtons();
      const at = `${SHADOW}.querySelector(${JSON.stringify(selector)})`;
      const painted = (await cdp.evaluate(
        `(() => { const b = ${at}; return !!b && getComputedStyle(b).display !== 'none'; })()`,
      )) as boolean;
      if (!painted) {
        out[name] = { text: null, box: null };
        continue;
      }
      await hover(at);
      out[name] = (await cdp.evaluate(tipOf(selector))) as Tip;
    }
    // Off the buttons again, so the next look is not taken through a label.
    await offButtons();
    return out;
  };
  const fab = `${SHADOW}.querySelector('.fab')`;
  const done = `${SHADOW}.querySelector('.picker-cancel')`;

  await look('idle');
  const tips = await readTips();
  await tap(fab);
  await look('entered');
  await tap(`document.getElementById('narrow')`);
  await look('composing');
  const tipsInMode = await readTips();
  // And again with the panel at its tallest: a refused post puts a line of
  // news and a Sign in button under the composer's row.
  await cdp.evaluate('window.__wantSignIn()');
  await cdp.evaluate(
    `${SHADOW}.querySelector('.composer textarea').value = 'the ferry times are wrong'`,
  );
  await cdp.evaluate(`${SHADOW}.querySelector('.composer .submit').click()`);
  await settle();
  await settle();
  await look('refused');
  await cdp.evaluate(`${SHADOW}.querySelector('.composer .cancel')?.click()`);
  await settle();
  await tap(done);
  await look('done');
  // A note beside the mic (a refusal, a lost connection) opens where the
  // mic's label would: with the pointer on the mic, is the label still drawn?
  const labelShown = async (): Promise<boolean> => {
    await offButtons();
    await hover(`${SHADOW}.querySelector('.fab-mic')`);
    return (await cdp.evaluate(
      `(() => { const a = getComputedStyle(${SHADOW}.querySelector('.fab-mic'), '::after');
        return a.display !== 'none' && !!a.content && a.content !== 'none'; })()`,
    )) as boolean;
  };
  const micLabelNoNote = await labelShown();
  await cdp.evaluate(
    `(() => { const r = ${SHADOW}.querySelector('.readout'); r.textContent = 'Voice feedback lost its connection.'; r.classList.remove('hidden'); })()`,
  );
  const micLabelUnderNote = await labelShown();
  await offButtons();
  return { width, height, looks, tips, tipsInMode, micLabelNoNote, micLabelUnderNote };
}

const runId = `micphone${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-mic-phone-'));
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
