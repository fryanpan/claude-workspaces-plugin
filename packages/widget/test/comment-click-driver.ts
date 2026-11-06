#!/usr/bin/env bun
/**
 * A reader commenting on an app's clickable rows, driven with real presses.
 *
 * Spawned by `widget-comment-click.test.ts`, which reads the JSON it prints.
 * The presses have to be real for the reason `post-click-driver.ts` gives:
 * the question is which listeners a press reaches, and in what order. A mouse
 * goes through `Input.dispatchMouseEvent`, a finger through
 * `Input.dispatchTouchEvent`, so the browser makes the click either way.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was measured in a running browser.
 */
import { spawnSync } from 'node:child_process';
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
import {
  type Pointer,
  type Press,
  type Reading,
  TARGETS,
  type Target,
} from './comment-click-driver-types.ts';

const TAG = 'claude-feedback-widget';
const SHADOW = `document.querySelector('${TAG}').shadowRoot`;

/**
 * An invented app. The rows open a panel, the way a list does, and each one
 * listens the way some framework would: bound to the row, delegated from the
 * document, or acting on the press instead of the click. `routed` is a link a
 * client-side router answers from the document.
 */
function appHtml(bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
 body{font:15px/1.5 system-ui;margin:0;padding:24px}
 .row{display:block;padding:12px;margin:0 0 8px;border:1px solid #ccc}
</style></head>
<body>
<h1>Harborlight orders</h1>
<a class="row" id="link" href="#opened">Riverbend invoice</a>
<a class="row" id="routed" href="#routed" data-route>Saltmarsh invoice</a>
<div class="row" id="direct">Alice's order</div>
<div class="row" id="delegated" data-open>Bob's order</div>
<div class="row" id="pressed">Harborlight's order</div>
<script>
window.__ran = [];
const ran = (name) => window.__ran.push(name);
document.getElementById('direct').addEventListener('click', () => ran('direct'));
document.addEventListener('click', (ev) => {
  if (ev.target.closest('[data-open]')) ran('delegated');
  if (ev.target.closest('[data-route]')) { ev.preventDefault(); ran('router'); }
});
for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchend']) {
  document.getElementById('pressed').addEventListener(type, () => ran(type));
}
</script>
<${TAG} doc-id="comment-click" workspace-id="w-demo" user="Test Reviewer" server-url="ws://127.0.0.1:1"></${TAG}>
<script>${bundle}</script>
</body></html>`;
}

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

async function drive(cdp: Cdp, dir: string, bundle: string, pointer: Pointer): Promise<Reading> {
  const finger = pointer === 'finger';
  const html = join(dir, `app-${pointer}.html`);
  writeFileSync(html, appHtml(bundle));
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: finger ? 430 : 1180,
    height: finger ? 932 : 820,
    deviceScaleFactor: 1,
    mobile: finger,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: finger, maxTouchPoints: 5 });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: `file://${html}` });
  await loaded;
  await sleep(500);

  const press = async (expr: string): Promise<void> => {
    const p = (await cdp.evaluate(`(() => { const e = ${expr}; if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`)) as {
      x: number;
      y: number;
    } | null;
    if (!p) throw new Error(`nothing to press at ${expr}`);
    if (finger) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
      await sleep(40);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      const m = { ...p, button: 'left', clickCount: 1 };
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...m, buttons: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...m, buttons: 0 });
    }
    await sleep(250);
  };

  const SUBJECT = `(() => {
    const sr = ${SHADOW};
    if (!sr.querySelector('.composer')) return null;
    const quote = sr.querySelector('.composer-snippet');
    if (quote) return quote.textContent;
    const lit = [...document.querySelectorAll('.row')].find((e) => /solid/.test(e.style.outline));
    return lit ? lit.textContent : null;
  })()`;
  const mode = (): Promise<boolean> =>
    cdp.evaluate(`document.querySelector('${TAG}').feedbackMode`) as Promise<boolean>;

  const sweep = async (): Promise<Record<Target, Press>> => {
    const out = {} as Record<Target, Press>;
    for (const t of TARGETS) {
      await cdp.evaluate(`window.__ran.length = 0; history.replaceState(null, '', '#'); 0`);
      await press(`document.getElementById('${t}')`);
      out[t] = (await cdp.evaluate(`({
        ran: window.__ran.slice(),
        hash: location.hash,
        subject: ${SUBJECT},
      })`)) as Press;
      // The next row starts with nothing open.
      if (out[t].subject !== null) await press(`${SHADOW}.querySelector('.composer .cancel')`);
    }
    return out;
  };

  const off = await sweep();
  await press(`${SHADOW}.querySelector('.fab')`);
  const armed = await mode();
  const on = await sweep();
  await press(`${SHADOW}.querySelector('.picker-cancel')`);
  const left = !(await mode());
  const after = await sweep();
  return { pointer, armed, left, off, on, after };
}

const runId = `commentclick${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'cw-comment-click-'));
let browser: Browser | undefined;
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
  const readings = [
    await drive(cdp, dir, bundle, 'mouse'),
    await drive(cdp, dir, bundle, 'finger'),
  ];
  cdp.close();
  console.log(JSON.stringify(readings));
} finally {
  try {
    browser?.proc.kill();
  } catch {}
  await sleep(400);
  rmSync(dir, { recursive: true, force: true });
  for (const name of profilesOfRun(readdirSync(tmpdir()), runId)) {
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    } catch {}
  }
}
process.exit(0);
