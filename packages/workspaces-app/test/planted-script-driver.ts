#!/usr/bin/env bun
/**
 * A doc and a comment that carry planted script, opened on the real doc page
 * in headless Chromium against a real server and the real doc bundle.
 *
 * The doc's markdown and the comment's text each carry a `<script>` tag, an
 * `<img onerror>`, a `javascript:` link, and a mermaid diagram with a
 * `javascript:` click link and a `click … call` callback. Every payload calls
 * `cwPlantedHit(<name>)`, which the page records. The driver clicks every
 * link, image and diagram node in the editor and in the comment with trusted
 * mouse events.
 *
 * The CONTROL is a `javascript:` link the driver appends to the page itself
 * and clicks last: it must record `control`, so a click on a script URL does
 * run in this browser, and an empty record is the sanitising rather than a
 * page where nothing could run. The reading also carries the planted words
 * as the page shows them, so a payload that never reached the page cannot
 * pass as one that was made inert.
 *
 * Spawned by `planted-script-browser.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — every value returned comes from the running page.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** The payloads, each naming itself to `cwPlantedHit`. */
const payloads = (at: 'doc' | 'comment') =>
  [
    `<script>cwPlantedHit('${at}-script')</script>`,
    '',
    `<img src="x" onerror="cwPlantedHit('${at}-img')">`,
    '',
    // Percent-encoded parentheses, so markdown ends the link where it should;
    // a browser decodes them before it runs a script URL.
    `Read the [Riverbend schedule](javascript:cwPlantedHit%28'${at}-link'%29) today.`,
    '',
    '```mermaid',
    'flowchart TD',
    '  Tide["Saltmarsh tide"] --> Ferry["Harborlight ferry"]',
    `  click Tide href "javascript:cwPlantedHit('${at}-mermaid-link')"`,
    `  click Ferry call cwPlantedHit("${at}-mermaid-call")`,
    '```',
  ].join('\n');

export const DOC = `# Harborlight tide notes\n\nThe table below is planted.\n\n${payloads('doc')}\n`;
export const COMMENT = `Saltmarsh check.\n\n${payloads('comment')}`;

export interface PlantedReading {
  /** Every payload that ran, the control's `control` among them. */
  ran: string[];
  /** Elements clicked in the editor and in the comment. */
  clicked: number;
  /** The doc's visible text, and the comment's. */
  docText: string;
  commentText: string;
  /** How many comment bodies on the page show the comment's words. */
  commentBodies: number;
  /** The doc's planted link: whether its words are a link, and its target. */
  docLink: { isLink: boolean; href: string | null };
  /** The doc's diagram drew, so its click lines were in a live SVG. */
  diagramDrawn: boolean;
  /** In the editor and every comment body: elements made from the payloads. */
  scripts: number;
  handlers: number;
  scriptLinks: number;
  plantedImages: number;
}

const step = (what: string): void => {
  process.stderr.write(`[planted-script-driver] ${what}\n`);
};

async function until<T>(what: string, read: () => Promise<T | null>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(100);
  }
  throw new Error(`never happened: ${what}`);
}

/** The parts of the page that hold the doc's and the comments' words. */
const SCOPE = `[...document.querySelectorAll('#editor, .thread-message, .body')]`;
/** Everything there a person could click. */
const TARGETS = 'a, img, svg g.node, svg a, svg text';

async function click(cdp: Cdp, x: number, y: number): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

/** Click every target in scope, each read right before its click. */
async function clickAll(cdp: Cdp): Promise<number> {
  const count = Number(
    await cdp.evaluate(`${SCOPE}.flatMap((s) => [...s.querySelectorAll('${TARGETS}')]).length`),
  );
  let clicked = 0;
  for (let i = 0; i < count; i++) {
    const at = (await cdp.evaluate(`(() => {
      const el = ${SCOPE}.flatMap((s) => [...s.querySelectorAll('${TARGETS}')])[${i}];
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    })()`)) as { x: number; y: number } | null;
    if (!at) continue;
    await click(cdp, at.x, at.y);
    clicked++;
  }
  return clicked;
}

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'planted-script-'));
  let handle: ServerHandle | undefined;
  try {
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    step('build the doc bundle');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
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
    const file = join(dir, 'tide-notes.md');
    writeFileSync(file, DOC);
    const author = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author })) as { workspace: { id: string } }
    ).workspace.id;
    const docId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'tide-notes',
          type: 'markdown',
          sourceUrl: file,
        })
      ).docId,
    );
    await post(`/workspaces/${ws}/docs/${docId}/threads/by_find`, {
      author,
      text: COMMENT,
      find: 'The table below is planted',
    });

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `planted-script-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // The recorder every payload calls, and a returning reader's name. A
    // click on any link but a script URL is cancelled, so no click can carry
    // the page away, or open a tab, before it is read.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.cwPlanted = [];
        window.cwPlantedHit = (n) => { window.cwPlanted.push(String(n)); };
        try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}
        document.addEventListener('click', (e) => {
          const a = e.target && e.target.closest && e.target.closest('a');
          if (!a) return;
          const href = a.getAttribute('href') ?? a.getAttribute('xlink:href') ?? '';
          if (!/^\\s*javascript:/i.test(href)) e.preventDefault();
        }, true);`,
    });
    step('open the doc');
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${base}/workspaces/${ws}/docs/${docId}` });
    await loaded;
    const docText = String(
      await until('the doc on screen', async () => {
        const t = String(
          await cdp.evaluate(`document.querySelector('#editor .ProseMirror')?.textContent ?? ''`),
        );
        return t.includes('Riverbend schedule') ? t : null;
      }),
    );
    const diagramDrawn = await until('the diagram drawn', async () =>
      (await cdp.evaluate(`!!document.querySelector('#editor svg g.node')`)) ? true : null,
    ).catch(() => false);
    const commentText = String(
      await until('the comment on screen', async () => {
        const t = String(
          await cdp.evaluate(
            `[...document.querySelectorAll('.thread-message, .body')].map((e) => e.textContent).join('\\n')`,
          ),
        );
        return t.includes('Saltmarsh check') ? t : null;
      }),
    );

    step('click everything in the doc and the comment');
    const clicked = await clickAll(cdp);
    const commentBodies = Number(
      await cdp.evaluate(
        `[...document.querySelectorAll('.thread-message, .body')].filter((e) => e.textContent.includes('Saltmarsh check')).length`,
      ),
    );
    const docLink = (await cdp.evaluate(`(() => {
      const a = [...document.querySelectorAll('#editor a')].find((x) => x.textContent.includes('Riverbend schedule'));
      return { isLink: !!a, href: a ? a.getAttribute('href') : null };
    })()`)) as PlantedReading['docLink'];

    step('the control');
    const control = (await cdp.evaluate(`(() => {
      const a = document.createElement('a');
      a.id = 'cw-planted-control';
      a.href = "javascript:cwPlantedHit('control')";
      a.textContent = 'control';
      a.style.cssText = 'position:fixed;left:0;top:0;padding:8px;background:#fff;z-index:99999';
      document.body.appendChild(a);
      const r = a.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)) as { x: number; y: number };
    await click(cdp, control.x, control.y);
    await until('the control link to run', async () =>
      (await cdp.evaluate(`window.cwPlanted.includes('control')`)) ? true : null,
    );
    const facts = (await cdp.evaluate(`(() => {
      document.getElementById('cw-planted-control').remove();
      const all = ${SCOPE}.flatMap((s) => [s, ...s.querySelectorAll('*')]);
      const attrs = (el) => Array.from(el.attributes);
      return {
        ran: window.cwPlanted.slice(),
        scripts: all.filter((el) => el.tagName.toLowerCase() === 'script').length,
        handlers: all.filter((el) => attrs(el).some((a) => /^on/i.test(a.name))).length,
        scriptLinks: all.filter((el) => attrs(el).some((a) => /href$/i.test(a.name) && /^\\s*javascript:/i.test(a.value))).length,
        plantedImages: all.filter((el) => el.tagName.toLowerCase() === 'img' && el.getAttribute('src') === 'x').length,
      };
    })()`)) as Pick<
      PlantedReading,
      'ran' | 'scripts' | 'handlers' | 'scriptLinks' | 'plantedImages'
    >;
    cdp.close();
    const reading: PlantedReading = {
      ...facts,
      clicked,
      docText,
      commentText,
      commentBodies,
      docLink,
      diagramDrawn,
    };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 170s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 170_000).unref();
await main();
process.exit(0);
