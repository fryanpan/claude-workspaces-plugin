#!/usr/bin/env bun
/**
 * Renders every hostile diagram in `mermaid-strict-page.ts` through both
 * Mermaid render paths in headless Chrome, clicks everything the diagram drew
 * with trusted mouse events, and prints one JSON reading per render.
 *
 * Run by `mermaid-strict-browser.test.ts`; a separate Bun process because the
 * page is bundled by `Bun.build` and served by `Bun.serve`, and vitest runs
 * under node.
 *
 * A link whose URL is not `javascript:` has its navigation cancelled, so a
 * click cannot carry the page away before it is read. A `javascript:` link is
 * left alone: running is exactly what the reading is looking for. The page
 * appends one such link of its own, outside any diagram, and clicks it last —
 * the positive control that a click on a script URL runs in this browser, and
 * the event the reading waits on instead of a fixed sleep.
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
import type { RenderPath } from './mermaid-strict-page.ts';

/**
 * Each payload calls `cwMermaidHit(n)`, which records `payload-n`. The
 * flowchart's labels carry an `<img onerror>` (1) and a `<script>` (2); its
 * `click` lines carry a `javascript:` link in both spellings (3, 5) and a page
 * callback (4). The sequence diagram carries an actor link (6) and a handler
 * in a message (7). Under loose, clicking the flowchart runs 3 and 5 on both
 * paths, and the sequence diagram keeps 7's `onerror` attribute in its SVG.
 * `SAFE_TEXT` is the text each diagram must still draw.
 */
const HOSTILE_DIAGRAMS: readonly string[] = [
  [
    'flowchart TD',
    '  A["<img src=x onerror=cwMermaidHit(1)>"] --> B["<script>cwMermaidHit(2)</script>"]',
    '  B --> Safe["Safe node<br>second line"]',
    '  click A href "javascript:cwMermaidHit(3)"',
    '  click B call cwMermaidHit(4)',
    '  click Safe "javascript:cwMermaidHit(5)"',
  ].join('\n'),
  [
    'sequenceDiagram',
    '  participant Riverbend',
    '  link Riverbend: Open @ javascript:cwMermaidHit(6)',
    '  Riverbend->>Riverbend: <img src=x onerror=cwMermaidHit(7)>',
  ].join('\n'),
];

export interface Reading {
  path: RenderPath;
  diagram: number;
  /** The diagram drew an SVG with its safe text in it. */
  rendered: boolean;
  /** What the render left behind instead, when it did not. */
  error: string;
  /** Every payload that ran, the control's `control` among them. */
  ran: string[];
  /** Elements in the rendered output carrying an `on*` attribute. */
  handlers: number;
  /** Links in the rendered output whose target is a `javascript:` URL. */
  scriptLinks: number;
  scripts: number;
  clicked: number;
}

const PATHS: readonly RenderPath[] = ['code-block', 'preview'];
/** Everything a diagram draws that a person could click. */
const TARGETS = 'svg a, svg g.node, svg .actor, svg text';
const SAFE_TEXT: readonly string[] = ['Safe node', 'Riverbend'];

async function bundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, 'mermaid-strict-page.ts')],
    target: 'browser',
  });
  if (!built.success) throw new Error(built.logs.map(String).join('\n'));
  return (await built.outputs[0]?.text()) ?? '';
}

async function poll<T>(read: () => Promise<T | null>, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const v = await read();
    if (v !== null) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function click(cdp: Cdp, x: number, y: number): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

async function readOne(cdp: Cdp, path: RenderPath, diagram: number): Promise<Reading> {
  const host = `#${
    (await cdp.evaluate(
      `window.cwMermaidRender(${JSON.stringify(path)}, ${JSON.stringify(HOSTILE_DIAGRAMS[diagram])})`,
    )) as string
  }`;
  const done = await poll(
    async () =>
      (await cdp.evaluate(`(() => {
        const host = document.querySelector(${JSON.stringify(host)});
        const svg = host?.querySelector('svg');
        const err = host?.querySelector('.cm-diagram-error, .mermaid-block:not(:has(svg))');
        return svg || err ? { svg: !!svg } : null;
      })()`)) as { svg: boolean } | null,
    `${path} render`,
  );
  const targets = (await cdp.evaluate(
    `document.querySelector(${JSON.stringify(host)}).querySelectorAll('${TARGETS}').length`,
  )) as number;
  let clicked = 0;
  for (let i = 0; i < targets; i++) {
    // Read each target's box right before its click: the previous scroll
    // moved every other one.
    const at = (await cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(host)}).querySelectorAll('${TARGETS}')[${i}];
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    })()`)) as { x: number; y: number } | null;
    if (!at) continue;
    await click(cdp, at.x, at.y);
    clicked++;
  }
  // The control: a script link the page itself owns, clicked last.
  const control = (await cdp.evaluate(`(() => {
    const a = document.createElement('a');
    a.href = "javascript:cwMermaidRan.push('control')";
    a.textContent = 'control';
    a.style.cssText = 'position:fixed;left:0;top:0;padding:8px;background:#fff;z-index:9';
    document.body.appendChild(a);
    const r = a.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)) as { x: number; y: number };
  await click(cdp, control.x, control.y);
  await poll(
    async () =>
      ((await cdp.evaluate(`window.cwMermaidRan.includes('control')`)) as boolean) ? true : null,
    'the control link to run',
  );
  const facts = (await cdp.evaluate(`(() => {
    const host = document.querySelector(${JSON.stringify(host)});
    const all = Array.from(host.querySelectorAll('*'));
    const handlers = all.filter((el) => Array.from(el.attributes).some((a) => /^on/i.test(a.name))).length;
    const scriptLinks = all.filter((el) => Array.from(el.attributes).some((a) => /href$/i.test(a.name) && /^\\s*javascript:/i.test(a.value))).length;
    document.querySelector('a[href="javascript:cwMermaidRan.push(\\'control\\')"]').remove();
    const ran = window.cwMermaidRan.slice();
    window.cwMermaidRan.length = 0;
    const svg = host.querySelector('svg');
    return {
      ran, handlers, scriptLinks,
      scripts: host.querySelectorAll('script').length,
      text: svg ? svg.textContent : '',
      error: svg ? '' : host.textContent.slice(0, 300),
    };
  })()`)) as {
    ran: string[];
    handlers: number;
    scriptLinks: number;
    scripts: number;
    text: string;
    error: string;
  };
  return {
    path,
    diagram,
    rendered: done.svg && facts.text.includes(SAFE_TEXT[diagram] ?? '\u0000'),
    error: facts.error,
    ran: facts.ran,
    handlers: facts.handlers,
    scriptLinks: facts.scriptLinks,
    scripts: facts.scripts,
    clicked,
  };
}

const js = await bundle();
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    if (new URL(req.url).pathname === '/app.js') {
      return new Response(js, { headers: { 'content-type': 'text/javascript' } });
    }
    return new Response(
      `<!doctype html><meta charset="utf-8"><body><script type="module" src="/app.js"></script>
<script>
  // Cancel every navigation except a script URL's, so a click cannot unload the page.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href') ?? a.getAttribute('xlink:href') ?? '';
    if (!/^\\s*javascript:/i.test(href)) e.preventDefault();
  }, true);
</script></body>`,
      { headers: { 'content-type': 'text/html' } },
    );
  },
});
const origin = `http://127.0.0.1:${server.port}`;
let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
let cdp: Cdp | undefined;
const readings: Reading[] = [];
try {
  browser = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
    STARTUP_TIMEOUT_MS,
    `${resolveRunId()}mermaid`,
    (b) => {
      browser = b;
    },
  );
  cdp = await Cdp.connect(await pageSocketUrl(browser.port, STARTUP_TIMEOUT_MS));
  await cdp.send('Page.enable');
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: origin });
  await withTimeout(loaded, 20_000, 'page load');
  await poll(
    async () =>
      ((await cdp!.evaluate(`typeof window.cwMermaidRender === 'function'`)) as boolean)
        ? true
        : null,
    'the page bundle',
  );
  for (const path of PATHS) {
    for (let d = 0; d < HOSTILE_DIAGRAMS.length; d++) readings.push(await readOne(cdp, path, d));
  }
} finally {
  cdp?.close();
  if (browser) await stopBrowser(browser.proc, browser.profile);
  server.stop(true);
}
process.stdout.write(`${JSON.stringify(readings)}\n`);
process.exit(0);
