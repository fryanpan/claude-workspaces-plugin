#!/usr/bin/env bun
/**
 * The comment view on a served mock with three pages, in headless Chromium
 * against a real board server, at 1180x820 and 430x932.
 *
 * The mock is one file that moves between Timetable, Book and Pay by its
 * fragment, as an agent writes one. A person's thread waits on each page.
 * The reader opens the mock on Book and taps Comments in the board's bar.
 * The driver reads what the view lists and the badges on the nav's links.
 * Then, with the page open, the agent replies on the Pay thread and an agent
 * on another board links that board's review item onto the Book thread; the
 * driver reads each arriving without a reload. Then the reader taps the Pay
 * thread under New: the page goes to Pay and shows the thread's spot, and on
 * a phone the thread fills a half-height sheet on its own. Then the Book
 * thread, the last one new, and the bar's dot goes; its item's link is
 * tapped, and the top page goes to the item.
 *
 * Spawned by `comment-view-browser.test.ts`, which reads the JSON it prints.
 * With `CW_SHOT_DIR` set it also writes a screenshot per width there.
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
  frameSessions,
  frameSurface,
  navigate,
  pageSurface,
  poll,
  step,
  tap,
} from './draft-reload-page.ts';
import { buildWidget } from './frame-driver-kit.ts';

export interface WidthReading {
  /** The sections the view lists, in order: [section, page, thread ids]. */
  listed: Array<[string, string, string[]]>;
  /** The badge on each nav link, by the link's words. */
  badges: Record<string, string | null>;
  /** The agent's reply, read in the open view under New, with no reload. */
  reply: { underNew: boolean; text: boolean; reloaded: boolean; hostDot: boolean };
  /** The linked item's row in the Book thread. */
  linked: { headline: string | null; board: string | null; href: string | null };
  /** After tapping the Pay thread under New. */
  opened: {
    hash: string;
    active: string | null;
    /** The Pay button's box in the frame, and the frame's height. */
    spot: { top: number; bottom: number } | null;
    frameHeight: number;
    /** The panel's height, and whether it shows that thread alone. */
    panelHeight: number;
    alone: boolean;
    back: string | null;
    stillUnderNew: boolean;
    /** Whether the board's bar still shows its new dot. */
    hostDot: boolean;
  };
  /** The bar's dot, once every new thread has been opened. */
  dotAfterAll: boolean;
  /** The host page's boxes, [left, top, right, bottom]: the bar, the board's
   *  nav, the frame and the window. */
  host: { bar: number[] | null; nav: number[] | null; frame: number[] | null; win: number[] };
  /** Where the top page went when the item's link was tapped. */
  followed: string;
}

export interface Reading {
  runs: Record<string, WidthReading>;
}

const HEADLINE = 'Turn on the tunnel for the Riverbend share?';
const REPLY = 'Moved the bike fee into the summary above the button.';

const mockPage = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harborlight Ferries booking</title>
<style>
 body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1d1d1b}
 nav{display:flex;gap:4px;padding:8px 16px;border-bottom:1px solid #e5e7eb}
 nav a{padding:10px 14px;color:#0b4f6c;text-decoration:none}
 section{padding:20px 24px 900px}
</style></head>
<body>
<nav><a href="#timetable">Timetable</a><a href="#book">Book</a><a href="#pay">Pay</a></nav>
<h1 id="title">Harborlight Ferries</h1>
<section data-pg="timetable"><h2 id="tt-row">07:40 Saltmarsh to Riverbend</h2></section>
<section data-pg="book"><h2 id="bk-seats">Choose a seat</h2></section>
<section data-pg="pay"><p style="height:500px">Card details</p><button id="pay-btn">Pay 18.40</button></section>
<script>
 const show = () => {
   const p = location.hash.slice(1) || 'timetable';
   for (const s of document.querySelectorAll('section')) s.hidden = s.dataset.pg !== p;
 };
 addEventListener('hashchange', show);
 show();
</script>
</body></html>`;

/** An element anchor by id, on one page of the mock, as the widget makes. */
const anchorOn = (mockUrl: string, page: string, id: string, tag: string, text: string) => ({
  kind: 'element',
  fingerprint: { id, tag, stableAttrs: {}, classes: [], text, path: '', dataAttrs: {} },
  snippet: { text },
  context: { url: `${mockUrl}?cw-frame=1#${page}` },
});

const VIEW = `(() => {
  const s = ${SHADOW};
  return [...(s?.querySelectorAll('.panel-threads [data-section]') ?? [])].map((x) => [
    x.dataset.section,
    x.querySelector('.section-heading')?.firstChild?.textContent ?? '',
    [...x.querySelectorAll('.thread')].map((t) => t.dataset.threadId),
  ]);
})()`;

const BADGES = `(() => {
  const out = {};
  const badges = [...document.querySelectorAll('.cw-link-badge')];
  for (const a of document.querySelectorAll('nav a')) {
    const r = a.getBoundingClientRect();
    const b = badges.find((x) => { const q = x.getBoundingClientRect(); return q.left >= r.left && q.left <= r.right + 4 && q.top <= r.top + 4; });
    out[a.textContent] = b ? b.textContent : null;
  }
  return out;
})()`;

let browser: { proc: ChildProcess; profile: string } | undefined;
let cdpFor: Cdp | undefined;

/** A screenshot into `CW_SHOT_DIR`, when it is set. */
async function shoot(name: string): Promise<void> {
  const dir = process.env.CW_SHOT_DIR;
  if (!dir || !cdpFor) return;
  const shot = (await cdpFor.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
  writeFileSync(join(dir, `comment-view-${name}.png`), Buffer.from(shot.data, 'base64'));
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'comment-view-'));
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
    const agent = { id: 'agent-harborlight', name: 'Harborlight agent', kind: 'agent' };
    const alice = { id: 'u-alice', name: 'Alice', kind: 'known', color: '#1a7f37' };
    const board = async (name: string) =>
      ((await post('/workspaces', { name, author: agent })) as { workspace: { id: string } })
        .workspace.id;
    const ws = await board('Harborlight');
    const other = await board('Saltmarsh');
    const task = (
      (await post(`/workspaces/${other}/tasks`, {
        title: 'Alice can open the Riverbend share link',
        body: 'Alice can open the share link so that she can review the booking flow.',
        author: agent,
      })) as { task: { id: string } }
    ).task.id;
    const itemId = (
      (await post(`/workspaces/${other}/tasks/${task}/review-items`, {
        review: { shape: 'review', headline: HEADLINE },
        author: agent,
      })) as { item: { id: string } }
    ).item.id;

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `comment-view-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    cdpFor = cdp;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const sessions = await frameSessions(cdp);
    const frame = frameSurface(cdp, sessions);
    const top = pageSurface(cdp);
    const runs: Reading['runs'] = {};
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
      const file = join(dir, `ferry-${width}.html`);
      writeFileSync(file, mockPage);
      const docId = String(
        (
          await post(`/workspaces/${ws}/docs`, {
            docId: `ferry-${width}`,
            type: 'mockup',
            sourceUrl: file,
          })
        ).docId,
      );
      await post(`/workspaces/${ws}/docs:attach`, { docId });
      const mockPath = `/workspaces/${ws}/mockups/${docId}`;
      const thread = async (page: string, id: string, tag: string, text: string, said: string) =>
        (
          (await post(`/workspaces/${ws}/docs/${docId}/threads`, {
            author: alice,
            text: said,
            anchor: anchorOn(mockPath, page, id, tag, text),
          })) as { thread: { id: string } }
        ).thread.id;
      const ids = {
        tt: await thread(
          'timetable',
          'tt-row',
          'H2',
          '07:40 Saltmarsh to Riverbend',
          'Bike space?',
        ),
        book: await thread('book', 'bk-seats', 'H2', 'Choose a seat', 'Which side gets sun?'),
        pay: await thread('pay', 'pay-btn', 'BUTTON', 'Pay 18.40', 'Show the bike fee first.'),
      };

      step(`open the mock at ${width} wide, on Book`);
      await navigate(cdp, `${base}${mockPath}#book`);
      await poll('the widget drew its pins', () =>
        frame.eval(`document.querySelectorAll('.cfw-pin').length`).then((n) => (n ? true : null)),
      );
      await frame.eval('(window.__cwBefore = 1)');
      const host = (await top.eval(`(() => {
        const box = (s) => {
          const e = document.querySelector(s);
          if (!e) return null;
          const b = e.getBoundingClientRect();
          return [b.left, b.top, b.right, b.bottom].map(Math.round);
        };
        return { bar: box('.cw-bar'), nav: box('.cw-host-nav'), frame: box('iframe[data-cw-mock-frame]'), win: [innerWidth, innerHeight] };
      })()`)) as WidthReading['host'];
      await tap(cdp, top, `document.querySelector('[data-cw-comments]')`, 'Comments');
      await poll('the view opened', () => frame.eval(`${Q('.panel.open')} ? true : null`));
      const listed = (await poll('the view listed three pages', () =>
        frame.eval(VIEW).then((v) => ((v as unknown[]).length >= 3 ? v : null)),
      )) as WidthReading['listed'];
      const badges = (await frame.eval(BADGES)) as WidthReading['badges'];
      await shoot(`${width}-listed`);

      step('the agent replies on Pay');
      await post(`/workspaces/${ws}/docs/${docId}/threads/${ids.pay}/comments`, {
        author: agent,
        text: REPLY,
      });
      const underNew = await poll('the reply under New', () =>
        frame
          .eval(
            `${SHADOW}?.querySelector('[data-section=new] .thread[data-thread-id="${ids.pay}"]')?.textContent ?? null`,
          )
          .then((t) => (typeof t === 'string' && t.includes('bike fee into') ? t : null)),
      ).catch(() => null);
      const hostDot = async () =>
        (await top.eval(`!document.querySelector('[data-cw-new]').hidden`)) === true;
      const reply = {
        underNew: underNew !== null,
        text: !!underNew?.includes(REPLY),
        reloaded: (await frame.eval('window.__cwBefore === undefined')) === true,
        hostDot: await poll('the bar’s dot', async () => ((await hostDot()) ? true : null)).catch(
          () => false,
        ),
      };

      step('an agent links the other board’s item onto Book');
      await post(`/workspaces/${ws}/docs/${docId}/threads/${ids.book}/linked-items`, {
        author: agent,
        item: { workspaceId: other, taskId: task, reviewItemId: itemId },
      });
      const linkedSel = `${SHADOW}?.querySelector('.thread[data-thread-id="${ids.book}"] [data-linked-item]')`;
      const linked = ((await poll('the linked item', () =>
        frame.eval(
          `(() => { const r = ${linkedSel}; return r ? { headline: r.querySelector('.hl')?.textContent ?? null, board: r.querySelector('.from')?.textContent ?? null, href: r.querySelector('a')?.getAttribute('href') ?? null } : null; })()`,
        ),
      ).catch(() => null)) ?? {
        headline: null,
        board: null,
        href: null,
      }) as WidthReading['linked'];

      step('tap the Pay thread under New');
      await tap(
        cdp,
        frame,
        `${SHADOW}?.querySelector('[data-section=new] .thread[data-thread-id="${ids.pay}"] .snippet')`,
        'the Pay thread',
      );
      await poll('the Pay thread open', () =>
        frame.eval(`${SHADOW}?.querySelector('.thread.active')?.dataset.threadId ?? null`),
      ).catch(() => null);
      // The spot is scrolled to a frame after the thread opens.
      await frame.eval(
        'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
      );
      const opened = (await frame.eval(`(() => {
        const s = ${SHADOW};
        const b = document.getElementById('pay-btn')?.getBoundingClientRect();
        const back = s.querySelector('[data-back]');
        return {
          hash: location.hash,
          active: s.querySelector('.thread.active')?.dataset.threadId ?? null,
          spot: b && b.height ? { top: Math.round(b.top), bottom: Math.round(b.bottom) } : null,
          frameHeight: innerHeight,
          panelHeight: Math.round(s.querySelector('.panel').getBoundingClientRect().height),
          alone: s.querySelectorAll('.thread').length === 1,
          back: back && back.offsetParent !== null ? back.textContent : null,
          stillUnderNew: !!s.querySelector('[data-section=new] .thread[data-thread-id="${ids.pay}"]'),
        };
      })()`)) as Omit<WidthReading['opened'], 'hostDot'>;
      await shoot(`${width}-opened`);
      const run: WidthReading = {
        listed,
        badges,
        reply,
        linked,
        opened: {
          ...opened,
          // The Book thread's linked item is still unread, so the dot stays.
          hostDot: await hostDot(),
        },
        dotAfterAll: true,
        host,
        followed: '',
      };

      step('open the Book thread, the last one new');
      if (mobile) await tap(cdp, frame, `${SHADOW}?.querySelector('[data-back]')`, 'All comments');
      await tap(
        cdp,
        frame,
        `${SHADOW}?.querySelector('[data-section=new] .thread[data-thread-id="${ids.book}"] .snippet')`,
        'the Book thread',
      );
      // The bar hears by message, so give it the moment that takes.
      run.dotAfterAll = !(await poll('the bar’s dot gone', async () =>
        (await hostDot()) ? null : true,
      ).catch(() => false));

      step('tap the item’s link');
      const link = `${SHADOW}?.querySelector('.thread.active[data-thread-id="${ids.book}"] [data-linked-item] a')`;
      await frame.eval(`${link}?.scrollIntoView({ block: 'center' })`);
      const left = cdp.once('Page.frameNavigated');
      await tap(cdp, frame, link, 'Open item').catch(() => {});
      await Promise.race([left, new Promise((r) => setTimeout(r, 5000))]);
      run.followed = String(await top.eval('location.pathname + location.search'));
      runs[String(width)] = run;
    }
    cdp.close();
    process.stdout.write(`\n${JSON.stringify({ runs } satisfies Reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 200s');
  const b = browser;
  void (b ? stopBrowser(b.proc, b.profile) : Promise.resolve()).finally(() => process.exit(3));
}, 200_000).unref();
await main();
process.exit(0);
