#!/usr/bin/env bun
/**
 * A component an agent saves runs in the real doc page, themed and
 * commentable, in headless Chromium against a real server and the real doc
 * bundle (the components design, task 5).
 *
 * The doc already holds a tag whose file does not exist yet. With the page
 * open, the "agent" writes the file into a declared folder — never committed
 * — and the driver times the page until the component draws. Then, at
 * 1180x820 and at 430 wide, it reads the component's type and colours against
 * the doc's own, drags the mouse across words the component drew, taps the
 * comment pill, types a comment and posts it, and reads back the thread the
 * server stored and the highlight the page drew in the tag's source.
 *
 * No request leaves the machine; the server's esm.sh fetch answers nothing.
 * Spawned by `mdx-component-every-editor-browser.test.ts`, which reads the
 * JSON it prints.
 *
 * audit: no-text — every value returned comes from the running page.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

export interface ThemeReading {
  /** The component paragraph's font and colour, and the doc paragraph's. */
  font: string;
  docFont: string;
  color: string;
  docColor: string;
  /** A component element coloured `var(--accent)`, and the board's accent. */
  accent: string;
  boardAccent: string;
}

export interface CommentReading {
  viewport: number;
  /** The pill showed for the selection inside the component. */
  pill: boolean;
  /** What the composer quoted. */
  quote: string;
  /** The stored thread's snippet, and the text its anchor covers on the page. */
  snippet: string;
  highlighted: string;
  /** The tag's source opened to show the comment. */
  sourceOpen: boolean;
}

export interface EveryEditorReading {
  /** From the agent's save to the component drawn on the open page. */
  agentSaveToPageMs: number;
  drawn: string;
  theme: ThemeReading;
  wide: CommentReading;
  narrow: CommentReading;
}

const step = (what: string): void => {
  process.stderr.write(`[every-editor-driver] ${what}\n`);
};

async function until<T>(what: string, read: () => Promise<T | null>, ms = 40_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined && v !== false) return v;
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

const TIDE = `export default function mount(el: HTMLElement, props: { label: string }) {
  const p = document.createElement('p');
  p.className = 'tide';
  p.textContent = \`\${props.label} high water at noon\`;
  const accent = document.createElement('span');
  accent.className = 'tide-accent';
  accent.style.color = 'var(--accent)';
  accent.textContent = 'Saltmarsh';
  el.append(p, accent);
}
`;

const DOC = `# Harborlight ferry

The ferry log.

import Tide from './agent/tide.tsx'

<Tide label="Riverbend" />

Riverbend notes below.
`;

const THEME = `(() => {
  const p = document.querySelector('#editor .mdx-live .tide');
  const doc = [...document.querySelectorAll('#editor .ProseMirror > p')].find((e) => e.textContent === 'The ferry log.');
  const accent = document.querySelector('#editor .mdx-live .tide-accent');
  if (!p || !doc || !accent) return null;
  const probe = document.createElement('span');
  probe.style.color = 'var(--accent)';
  document.body.append(probe);
  const boardAccent = getComputedStyle(probe).color;
  probe.remove();
  const ps = getComputedStyle(p);
  const ds = getComputedStyle(doc);
  return {
    font: ps.fontFamily + ' ' + ps.fontSize,
    docFont: ds.fontFamily + ' ' + ds.fontSize,
    color: ps.color,
    docColor: ds.color,
    accent: getComputedStyle(accent).color,
    boardAccent,
  };
})()`;

/** The client-space box of `words` inside the component's paragraph. */
const WORDS_BOX = (words: string) => `(() => {
  const p = document.querySelector('#editor .mdx-live .tide');
  const t = p && p.firstChild;
  if (!t) return null;
  const at = t.data.indexOf(${JSON.stringify(words)});
  p.scrollIntoView({ block: 'center' });
  const r = document.createRange();
  r.setStart(t, at);
  r.setEnd(t, at + ${words.length});
  const b = r.getBoundingClientRect();
  return { left: b.left, right: b.right, y: b.top + b.height / 2 };
})()`;

let browser: { proc: ChildProcess; profile: string } | undefined;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mdx-every-editor-'));
  let handle: ServerHandle | undefined;
  try {
    step('build the doc bundle');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`doc bundle build failed:\n${built.stderr}`);
    const repo = join(dir, 'harborlight');
    mkdirSync(join(repo, 'agent'), { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'agent', 'component.json'), '{}');
    writeFileSync(join(repo, 'ferry.mdx'), DOC);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
      componentFetch: async () => new Response('not here', { status: 404 }),
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
    const author = { id: 'agent-harborlight', name: 'Harborlight notes', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author })) as { workspace: { id: string } }
    ).workspace.id;
    const docId = String(
      (
        await post(`/workspaces/${ws}/docs`, {
          docId: 'ferry',
          type: 'markdown',
          sourceUrl: join(repo, 'ferry.mdx'),
        })
      ).docId,
    );

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `mdx-every-editor-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
    });
    const url = `${base}/workspaces/${ws}/docs/${docId}`;
    const open = async (width: number, height: number) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      step(`open the doc at ${width}x${height}`);
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded;
    };

    await open(1180, 820);
    await until('the doc page with its tag', async () =>
      cdp.evaluate(`!!document.querySelector('#editor .mdx-block')`),
    );
    step('the agent saves the component file');
    const savedAt = performance.now();
    writeFileSync(join(repo, 'agent', 'tide.tsx'), TIDE);
    const drawn = (await until('the saved component on the open page', async () =>
      cdp.evaluate(`document.querySelector('#editor .mdx-live .tide')?.textContent ?? null`),
    )) as string;
    const agentSaveToPageMs = Math.round(performance.now() - savedAt);
    const theme = (await until('the theme reading', async () =>
      cdp.evaluate(THEME),
    )) as ThemeReading;

    const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
      cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });

    const comment = async (viewport: number, words: string, text: string) => {
      const box = (await until('the words to select', async () =>
        cdp.evaluate(WORDS_BOX(words)),
      )) as { left: number; right: number; y: number };
      await sleep(100);
      const again = (await cdp.evaluate(WORDS_BOX(words))) as typeof box;
      step(`drag across "${words}"`);
      await mouse('mouseMoved', again.left + 1, again.y);
      await mouse('mousePressed', again.left + 1, again.y, { clickCount: 1 });
      for (let i = 1; i <= 5; i++) {
        const x = again.left + 1 + ((again.right - again.left - 2) * i) / 5;
        await mouse('mouseMoved', x, again.y, { buttons: 1 });
      }
      await mouse('mouseReleased', again.right - 1, again.y, { clickCount: 1 });
      const pill = Boolean(
        await until('the comment pill', async () =>
          cdp.evaluate(
            `(() => { const p = document.getElementById('comment-pill'); return !!p && !p.classList.contains('hidden') && p.offsetWidth > 0; })()`,
          ),
        ).catch(() => false),
      );
      step('tap the pill and write the comment');
      await cdp.evaluate(`document.getElementById('comment-pill').click(); true`);
      await until('the composer', async () =>
        cdp.evaluate(`!document.getElementById('composer')?.classList.contains('hidden')`),
      );
      const quote = String(
        await cdp.evaluate(`document.getElementById('composer-quote')?.textContent ?? ''`),
      );
      await until('the composer has focus', async () =>
        cdp.evaluate(
          `(() => { const c = document.getElementById('composer'); return !!c && c.contains(document.activeElement); })()`,
        ),
      );
      await cdp.send('Input.insertText', { text });
      await cdp.evaluate(`document.getElementById('composer-submit').click(); true`);
      const thread = (await until('the stored thread', async () => {
        const res = await fetch(`${base}/workspaces/${ws}/docs/${docId}/threads`);
        const body = (await res.json()) as {
          threads: Array<{
            id: string;
            snippet?: { text?: string };
            anchor?: { snippet?: { text?: string } };
            comments: Array<{ text: string }>;
          }>;
        };
        return body.threads.find((t) => t.comments.some((c) => c.text.includes(text))) ?? null;
      })) as { snippet?: { text?: string }; anchor?: { snippet?: { text?: string } } };
      const highlighted = String(
        await until('the highlight in the tag source', async () =>
          cdp.evaluate(
            `[...document.querySelectorAll('#editor .mdx-block .mdx-source .thread-range')].map((e) => e.textContent).join('') || null`,
          ),
        ),
      );
      const sourceOpen = Boolean(
        await cdp.evaluate(
          `document.querySelector('#editor .mdx-block.has-component')?.classList.contains('is-open') ?? false`,
        ),
      );
      return {
        viewport,
        pill,
        quote,
        snippet: thread.anchor?.snippet?.text ?? thread.snippet?.text ?? '',
        highlighted,
        sourceOpen,
      };
    };

    const wide = await comment(1180, 'high water', 'Is this Harborlight time');
    await open(430, 932);
    await until('the component at 430', async () =>
      cdp.evaluate(`!!document.querySelector('#editor .mdx-live .tide')`),
    );
    const narrow = await comment(430, 'at noon', 'Riverbend agrees');
    cdp.close();
    const reading: EveryEditorReading = { agentSaveToPageMs, drawn, theme, wide, narrow };
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
