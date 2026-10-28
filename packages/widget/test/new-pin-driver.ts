#!/usr/bin/env bun
/**
 * A comment left through the widget on a mock the board serves, and the pin
 * it leaves on its element, in headless Chromium against a real board server.
 *
 * The reader opens the mock's board address, turns comment mode on, taps an
 * element, types and posts: a heading, a paragraph, a chart label the page's
 * script draws, and a cell of a grid. Then the agent writes the mock's next
 * round, which the page swaps in place without a reload, and the reader
 * comments on the same four again. After each post the driver reads the
 * thread on the server, the thread in the frame's copy of the doc, and the
 * pin: whether its drop is drawn and where its tip is. One mock per width,
 * 1180x820 and 430 wide, so no pin from one run stands over an element the
 * other taps.
 *
 * Spawned by `new-pin.test.ts`, which reads the JSON it prints.
 */
// audit: no-text
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cdp, launchChrome, pageSocketUrl, stopBrowser } from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import {
  Q,
  SHADOW,
  type Surface,
  TAG,
  frameSessions,
  frameSurface,
  navigate,
  poll,
  ready,
  step,
  tap,
  tapUntil,
} from './draft-reload-page.ts';
import { buildWidget } from './frame-driver-kit.ts';
import { type After, type Reading, TARGETS, type Target, onElement } from './new-pin-page.ts';

/** A report mock, as an agent writes one: headings, a paragraph, a grid of
 *  figures, and a chart its own script draws into an svg. Its own stylesheet
 *  is in the head, as a mock's is. Round two adds a paragraph at the top. */
const mockPage = (round: number) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Saltmarsh tide report</title>
<style>
 body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1d1d1b}
 main{max-width:760px;padding:24px 32px}
 .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
 .mi{padding:6px 10px;background:#f1efe8}
</style></head>
<body><main>
 <h1 id="title">Saltmarsh tide report</h1>
 ${round > 1 ? '<p id="round-two">Harborlight readings added.</p>' : ''}
 <h3>Readings</h3>
 <p>From the Riverbend gauge, read each morning.</p>
 <h3>Riverbend high water by month</h3>
 <div id="chart"></div>
 <p id="lede">The June peak is the highest since the gauge opened.</p>
 <div class="grid"><div class="mi">May</div><div class="mi">3.8 m</div><div class="mi">4.1 m</div></div>
</main>
<script>
 const ns = 'http://www.w3.org/2000/svg';
 const svg = document.createElementNS(ns, 'svg');
 svg.setAttribute('width', '360');
 svg.setAttribute('height', '120');
 const g = document.createElementNS(ns, 'g');
 const bar = document.createElementNS(ns, 'rect');
 for (const [k, v] of [['x', 20], ['y', 30], ['width', 60], ['height', 80]]) bar.setAttribute(k, v);
 const label = document.createElementNS(ns, 'text');
 label.setAttribute('x', '100');
 label.setAttribute('y', '60');
 label.textContent = 'June peak';
 g.append(bar, label);
 svg.append(g);
 document.getElementById('chart').append(svg);
</script>
</body></html>`;

/** What the frame shows of the thread whose first comment says `text`. */
const AFTER = (find: string, text: string) => `(() => {
  const w = document.querySelector('${TAG}');
  const threads = w?.client ? [...w.client.ydoc.getMap('threads').entries()] : [];
  const [id] = threads.find(([, t]) => (t.get('comments')?.toArray() ?? []).some((c) => c.get('text') === ${JSON.stringify(text)})) ?? [];
  const pin = id ? [...document.querySelectorAll('.cfw-pin')].find((p) => p.dataset.threadId === id) : null;
  const pr = pin?.getBoundingClientRect();
  const drop = pin && getComputedStyle(pin, '::before');
  const e = ${find};
  const r = e?.getBoundingClientRect();
  return {
    inFrame: !!id,
    pin: pin ? {
      drawn: !pin.hidden && pr.width > 0 && drop.content !== 'none' && drop.backgroundColor !== 'rgba(0, 0, 0, 0)',
      tip: [Math.round(pr.left + 22), Math.round(pr.top + 33)],
    } : null,
    el: r && (r.width || r.height) ? [r.left, r.top, r.right, r.bottom].map(Math.round) : null,
  };
})()`;

let browser: { proc: ChildProcess; profile: string } | undefined;

/**
 * Press the element `fx` of the way across its box, until the composer opens.
 * A pin stands where its element was tapped, so the second round's comment
 * presses a different spot from the first's: on the same spot it would open
 * the first comment's thread, as it should.
 */
async function pressAcross(cdp: Cdp, s: Surface, find: string, fx: number): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const at = await poll(`the element ${find}`, async () => {
      const r = (await s.eval(
        `(() => { const b = ${find}?.getBoundingClientRect(); return b && b.width ? { x: b.left + b.width * ${fx}, y: b.top + b.height / 2 } : null; })()`,
      )) as { x: number; y: number } | null;
      if (!r) return null;
      const o = await s.offset();
      return { x: r.x + o.x, y: r.y + o.y };
    });
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await cdp.send('Input.dispatchMouseEvent', { ...at, type, button: 'left', clickCount: 1 });
    }
    for (let i = 0; i < 40; i++) {
      if (await s.eval(`!!${Q('.composer textarea')}`)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    step(`press ${attempt} on ${find} opened no composer`);
  }
  throw new Error(`never happened: a composer on ${find}`);
}

async function comment(
  cdp: Cdp,
  s: Surface,
  find: string,
  fx: number,
  text: string,
  posted: () => boolean,
): Promise<After> {
  await tapUntil(cdp, s, Q('.fab'), Q('.picker-banner'), 'the comment button');
  await s.eval(`${find}.scrollIntoView({ block: 'center' })`);
  await pressAcross(cdp, s, find, fx);
  await tap(cdp, s, Q('.composer textarea'), 'the composer');
  await cdp.send('Input.insertText', { text });
  await poll('the composer holds the words', () =>
    s.eval(`${Q('.composer textarea')}?.value`).then((v) => (v === text ? true : null)),
  );
  await tapUntil(cdp, s, Q('.composer .submit'), `!${Q('.composer')}`, 'Post');
  const ok = await poll('the comment reached the board', () => (posted() ? true : null)).catch(
    () => false,
  );
  // The pin comes with the render the thread's arrival schedules: wait for it
  // to stand on its element, or for the frame to have had ample time to.
  let last = { posted: ok, ...((await s.eval(AFTER(find, text))) as Omit<After, 'posted'>) };
  for (let i = 0; i < 40 && !onElement(last); i++) {
    await new Promise((r) => setTimeout(r, 50));
    last = { posted: ok, ...((await s.eval(AFTER(find, text))) as Omit<After, 'posted'>) };
  }
  await s.eval(`${SHADOW}?.querySelector('.picker-banner .picker-cancel')?.click()`);
  return last;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'new-pin-'));
  let handle: ServerHandle | undefined;
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
    const base = `http://127.0.0.1:${h.port}`;
    const post = async (path: string, payload: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const agent = { id: 'agent-saltmarsh', name: 'Saltmarsh report', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Saltmarsh', author: agent })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const mock = async (name: string) => {
      const file = join(dir, `${name}.html`);
      writeFileSync(file, mockPage(1));
      const id = String(
        (await post(`/workspaces/${ws}/docs`, { docId: name, type: 'mockup', sourceUrl: file }))
          .docId,
      );
      await post(`/workspaces/${ws}/docs:attach`, { docId: id });
      return { id, file, url: `${base}/workspaces/${ws}/mockups/${id}` };
    };

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `new-pin-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const sessions = await frameSessions(cdp);
    const frame = frameSurface(cdp, sessions);
    const runs: Reading['runs'] = {};
    const swapped: Reading['swapped'] = {};
    for (const [width, height, mobile] of [
      [1180, 820, false],
      [430, 932, true],
    ] as const) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
      });
      const m = await mock(`saltmarsh-${width}`);
      const round = async (key: string, words: string, fx: number) => {
        const run = {} as Record<Target, After>;
        for (const [name, find] of Object.entries(TARGETS) as Array<[Target, string]>) {
          const text = `Riverbend ${words} ${width} ${name}`;
          step(`${key}: comment on ${name}`);
          run[name] = await comment(cdp, frame, find, fx, text, () =>
            h.docStore.listThreads(m.id).some((t) => t.comments[0]?.text === text),
          ).catch((err) => {
            step(`${key}: comment on ${name} could not run: ${String(err)}`);
            return { posted: false, inFrame: false, pin: null, el: null };
          });
        }
        runs[key] = run;
      };
      step(`open the mock at ${width} wide`);
      await navigate(cdp, m.url);
      await ready(frame);
      await round(String(width), 'first', 0.5);
      step('the agent writes round two');
      writeFileSync(m.file, mockPage(2));
      swapped[String(width)] = await poll('round two swapped in', () =>
        frame.eval(`!!document.getElementById('round-two')`).then((v) => (v ? true : null)),
      ).catch(() => false);
      await round(`${width}-swapped`, 'second', 0.15);
    }
    cdp.close();
    process.stdout.write(`\n${JSON.stringify({ runs, swapped } satisfies Reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
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
