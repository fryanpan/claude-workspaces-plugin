#!/usr/bin/env bun
/**
 * A relative link in a doc — `[Riverbend data](part-1/2-riverbend-data.mdx)`
 * — followed on the real doc page, in headless Chromium against a real server
 * and the real doc bundle: a plain click at 1180x820, a tap at 430x932 with
 * touch, a Cmd/Ctrl-click, an Alt-click that edits the link's words, and a
 * link whose file no doc on the board is bound to.
 *
 * The doc is editable, as it is for anyone who can write it, which is the
 * state the owner reported it from: a plain click and a tap did nothing,
 * and only Cmd/Ctrl-click went anywhere.
 *
 * Spawned by `relative-link-open-browser.test.ts`, which reads the JSON it
 * prints on its last line.
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

export type LinkName = 'riverbend' | 'saltmarsh' | 'missing';
export type Gesture = 'click' | 'touch' | 'new-tab-click' | 'alt-click-type';

export interface RelativeLinkCase {
  width: number;
  link: LinkName;
  gesture: Gesture;
  /** The link's `href` attribute as the editor drew it. */
  href: string | null;
  /** This tab's path and query after the gesture settled. */
  pagePath: string;
  /** The first heading on this tab after the gesture. */
  heading: string | null;
  /** This tab shows a not-found page. */
  notFound: boolean;
  /** Paths the new tabs this gesture opened settled on. */
  opened: string[];
  /** The link's words after the gesture (the Alt-click case types into them). */
  linkText: string | null;
}

export interface RelativeLinkRun {
  guidePath: string;
  riverbendPath: string;
  saltmarshPath: string;
  cases: RelativeLinkCase[];
}

const step = (what: string): void => {
  process.stderr.write(`[relative-link-open] ${what}\n`);
};

async function until<T>(what: string, read: () => Promise<T | null>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read().catch(() => null);
    if (v !== null && v !== undefined) return v;
    await sleep(50);
  }
  throw new Error(`never happened: ${what}`);
}

const GUIDE = [
  '# Harborlight guide',
  '',
  'Read [Riverbend data and notes](part-1/2-riverbend-data.mdx) first.',
  '',
  'Then [Saltmarsh tides](notes/saltmarsh-tides.md) for the tide table.',
  '',
  'The [appendix Bob owes us](part-9/appendix.md) is not written yet.',
  '',
].join('\n');

const LINK_WORDS: Record<LinkName, string> = {
  riverbend: 'Riverbend data',
  saltmarsh: 'Saltmarsh tides',
  missing: 'appendix Bob',
};

/** Where a link is on the editable doc, once the editor has mounted. */
const linkAt = (words: string): string => `(() => {
  if (!document.querySelector('#editor .ProseMirror[contenteditable="true"]')) return null;
  const a = Array.from(document.querySelectorAll('#editor .ProseMirror a'))
    .find((el) => (el.textContent || '').includes(${JSON.stringify(words)}));
  if (!a) return null;
  a.scrollIntoView({ block: 'center' });
  const r = a.getBoundingClientRect();
  if (r.width === 0) return null;
  return { x: r.left + Math.min(r.width / 2, 24), y: r.top + r.height / 2, href: a.getAttribute('href') };
})()`;

const linkText = (words: string): string => `(() => {
  const a = Array.from(document.querySelectorAll('#editor .ProseMirror a'))
    .find((el) => (el.textContent || '').includes(${JSON.stringify(words.split(' ')[0])}));
  return a ? a.textContent : null;
})()`;

const PAGE = `(() => ({
  path: location.pathname + location.search,
  heading: (document.querySelector('#editor h1') || document.querySelector('h1'))?.textContent?.trim() || null,
  notFound: /Nothing on this board answers|Page not found|Doc not found|not found/i.test(document.body ? document.body.innerText : ''),
  ready: document.readyState === 'complete',
}))()`;

interface Page {
  path: string;
  heading: string | null;
  notFound: boolean;
  ready: boolean;
}

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function openBrowser(width: number, height: number): Promise<{ cdp: Cdp; port: number }> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile),
    STARTUP_TIMEOUT_MS,
    `relative-link-open-${width}-${process.pid}`,
    (started) => {
      browsers.push(started);
    },
  );
  const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const mobile = width <= 1100;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  if (mobile) {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
  });
  return { cdp, port: b.port };
}

async function tabs(port: number): Promise<Array<{ id: string; url: string }>> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(10_000),
  });
  const list = (await res.json()) as Array<{ id: string; type: string; url: string }>;
  return list.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url }));
}

/** CDP's modifier bits: 1 is Alt, 2 is Ctrl, 4 is Meta (Cmd). */
const NEW_TAB_MOD = process.platform === 'darwin' ? 4 : 2;
const ALT_MOD = 1;

async function click(cdp: Cdp, x: number, y: number, modifiers = 0): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      clickCount: 1,
      modifiers,
    });
  }
}

/** A short tap: a finger down and up at once, no hold. */
async function touch(cdp: Cdp, x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * One size, in a function of its own: a scope a call creates is a new scope
 * each call (the JIT note in `lead-chat-link-tabs-browser-driver.ts`).
 */
async function casesAt(
  width: number,
  height: number,
  guideUrl: string,
  plans: ReadonlyArray<readonly [LinkName, Gesture]>,
): Promise<RelativeLinkCase[]> {
  const out: RelativeLinkCase[] = [];
  const { cdp, port } = await openBrowser(width, height);
  const guidePath = new URL(guideUrl).pathname;
  for (const [link, gesture] of plans) {
    step(`${link} by ${gesture} at ${width}`);
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: guideUrl });
    await loaded;
    const at = await until(
      `the ${link} link`,
      async () =>
        (await cdp.evaluate(linkAt(LINK_WORDS[link]))) as {
          x: number;
          y: number;
          href: string | null;
        } | null,
    );
    const before = new Set((await tabs(port)).map((t) => t.id));
    if (gesture === 'touch') await touch(cdp, at.x, at.y);
    else if (gesture === 'new-tab-click') await click(cdp, at.x, at.y, NEW_TAB_MOD);
    else if (gesture === 'alt-click-type') await click(cdp, at.x, at.y, ALT_MOD);
    else await click(cdp, at.x, at.y);

    let opened: string[] = [];
    if (gesture === 'new-tab-click') {
      // The new tab is first at the open route, then at the doc it redirects to.
      opened = await until(
        'a new tab settled on a doc',
        async () => {
          const fresh = (await tabs(port)).filter((t) => !before.has(t.id));
          if (fresh.length === 0) return null;
          const paths = fresh.map((t) => new URL(t.url).pathname);
          return paths.every((p) => p.includes('/docs/')) ? paths : null;
        },
        10_000,
      ).catch(async () => (await tabs(port)).filter((t) => !before.has(t.id)).map((t) => t.url));
    } else if (gesture === 'alt-click-type') {
      // The caret lands in the link's words, and a key types there.
      await until('the caret inside the link', async () =>
        (await cdp.evaluate(`(() => {
          const n = getSelection()?.anchorNode;
          const el = n && (n.nodeType === 1 ? n : n.parentElement);
          return !!(el && el.closest && el.closest('#editor .ProseMirror a'));
        })()`))
          ? true
          : null,
      ).catch(() => step('the caret never reached the link'));
      await cdp.send('Input.insertText', { text: 'Z' });
      await until('the typed letter in the link', async () =>
        String((await cdp.evaluate(linkText(LINK_WORDS[link]))) ?? '').includes('Z') ? true : null,
      ).catch(() => step('the typed letter never reached the link'));
    } else {
      // A gesture that goes somewhere leaves the guide within a few seconds.
      await until(
        'this tab to leave the guide',
        async () => {
          const p = (await cdp.evaluate(PAGE)) as Page;
          return p.path.startsWith(guidePath) ? null : true;
        },
        8000,
      ).catch(() => step(`the ${link} ${gesture} went nowhere`));
    }
    const page = await until(
      'this tab settled',
      async () => {
        const p = (await cdp.evaluate(PAGE)) as Page;
        if (!p.ready) return null;
        // A doc page draws its heading once the doc has synced.
        if (p.path.includes('/docs/') && !p.notFound && !p.heading) return null;
        return p;
      },
      15_000,
    ).catch(async () => (await cdp.evaluate(PAGE)) as Page);
    const text = page.path.startsWith(guidePath)
      ? ((await cdp.evaluate(linkText(LINK_WORDS[link]))) as string | null)
      : null;
    for (const t of await tabs(port)) {
      if (!before.has(t.id)) {
        await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`, {
          signal: AbortSignal.timeout(10_000),
        });
      }
    }
    out.push({
      width,
      link,
      gesture,
      href: at.href,
      pagePath: page.path,
      heading: page.heading,
      notFound: page.notFound,
      opened,
      linkText: text,
    });
  }
  cdp.close();
  return out;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'relative-link-open-'));
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
    mkdirSync(join(repo, 'part-1'), { recursive: true });
    mkdirSync(join(repo, 'notes'), { recursive: true });
    writeFileSync(join(repo, 'guide.md'), GUIDE);
    writeFileSync(
      join(repo, 'part-1', '2-riverbend-data.mdx'),
      '# Riverbend data\n\nCounts by year.\n',
    );
    writeFileSync(join(repo, 'notes', 'saltmarsh-tides.md'), '# Saltmarsh tides\n\nHigh at six.\n');
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
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
    const author = { id: 'known-alice', name: 'Alice', kind: 'known' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author })) as { workspace: { id: string } }
    ).workspace.id;
    const bind = async (docId: string, file: string): Promise<string> =>
      String(
        (
          await post(`/workspaces/${ws}/docs`, {
            docId,
            type: 'markdown',
            sourceUrl: join(repo, file),
          })
        ).docId,
      );
    const guide = await bind('guide', 'guide.md');
    const riverbend = await bind('riverbend-data', 'part-1/2-riverbend-data.mdx');
    const saltmarsh = await bind('saltmarsh-tides', 'notes/saltmarsh-tides.md');
    const docPath = (id: string) => `/workspaces/${ws}/docs/${encodeURIComponent(id)}`;
    const guideUrl = `${base}${docPath(guide)}`;

    const cases = [
      ...(await casesAt(1180, 820, guideUrl, [
        ['riverbend', 'click'],
        ['saltmarsh', 'click'],
        ['riverbend', 'new-tab-click'],
        ['missing', 'click'],
        ['riverbend', 'alt-click-type'],
      ])),
      ...(await casesAt(430, 932, guideUrl, [
        ['riverbend', 'touch'],
        ['saltmarsh', 'touch'],
      ])),
    ];
    const run: RelativeLinkRun = {
      guidePath: docPath(guide),
      riverbendPath: docPath(riverbend),
      saltmarshPath: docPath(saltmarsh),
      cases,
    };
    process.stdout.write(`\n${JSON.stringify(run)}\n`);
  } finally {
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 200s');
  void Promise.all(browsers.map((b) => stopBrowser(b.proc, b.profile))).finally(() =>
    process.exit(3),
  );
}, 200_000).unref();
await main();
process.exit(0);
