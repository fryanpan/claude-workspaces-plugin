#!/usr/bin/env bun
/**
 * The needs-review mark on links in a doc, in headless Chromium against a
 * real server and the real bundles, at 1180x820 and 430x932.
 *
 * The board holds three tasks — one with an open review item, one plain, and
 * one whose open item is about a mock — and a doc that links the first two
 * tasks and the mock. At each size the driver opens the doc and reads, for
 * every link, the elements drawn after it. At 430 it then:
 *
 *  - opens the waiting task from its link (a real click) and reads where its
 *    review queue sits in the viewport, against the same task opened from a
 *    plain address (the control);
 *  - reopens the doc, answers the item from outside the page, and reads that
 *    the mark goes with the link still where it was.
 *
 * `CW_SHOT_DIR` set: the doc is saved there as `review-markers-<width>.png`.
 *
 * Spawned by `doc-review-marks-browser.test.ts`, which reads the JSON it
 * prints.
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

const ALICE = { id: 'known-alice', name: 'Alice', kind: 'known' };
const LEAD = { id: 'agent-harborlight', name: 'Harborlight Lead', kind: 'known' };

/** The elements drawn after one link, up to the next link: their classes. */
export type LinkRead = string[];

export interface Landing {
  /** The address the browser navigated to. */
  opened: string;
  /** The review queue's top, and the viewport's height. */
  queueTop: number;
  viewport: number;
}

export interface ReviewMarksWidthRun {
  width: number;
  links: { waiting: LinkRead | null; plain: LinkRead | null; mock: LinkRead | null };
  /** 430 only. */
  landing?: { fromLink: Landing | null; plainOpen: Landing | null };
  /** 430 only: after the item is answered elsewhere, with the doc open. */
  live?: {
    /** Whether the mark had gone within the 1s every surface has. */
    droppedInTime: boolean;
    waiting: LinkRead | null;
    mock: LinkRead | null;
    /** The waiting link's box before and after, as `left,top,width,height`. */
    boxBefore: string | null;
    boxAfter: string | null;
  };
}

export interface ReviewMarksRun {
  widths: ReviewMarksWidthRun[];
}

const step = (what: string): void => {
  process.stderr.write(`[doc-review-marks] ${what}\n`);
};

async function until<T>(
  what: string,
  read: () => Promise<T | null> | T | null,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== null && v !== undefined) return v;
    await sleep(25);
  }
  throw new Error(`never happened: ${what}`);
}

const browsers: Array<{ proc: ChildProcess; profile: string }> = [];

async function openBrowser(width: number, height: number): Promise<Cdp> {
  const b = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width, height }, profile, ['--mute-audio']),
    STARTUP_TIMEOUT_MS,
    `doc-review-marks-${width}-${process.pid}`,
    (started) => {
      browsers.push(started);
    },
  );
  const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width <= 1100,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('feedback-user-name', 'Alice'); } catch {}`,
  });
  return cdp;
}

async function go(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
}

/** What is drawn after the doc's link to `id`, once its lookup has landed. */
const readLink = (id: string): string => `(() => {
  const a = [...document.querySelectorAll('.ProseMirror a[href]')]
    .find((x) => (x.getAttribute('href') || '').includes(${JSON.stringify(id)}));
  if (!a) return null;
  const out = [];
  for (let n = a.nextElementSibling; n && n.tagName !== 'A'; n = n.nextElementSibling) {
    out.push(n.className);
  }
  return out;
})()`;

const boxOf = (id: string): string => `(() => {
  const a = [...document.querySelectorAll('.ProseMirror a[href]')]
    .find((x) => (x.getAttribute('href') || '').includes(${JSON.stringify(id)}));
  if (!a) return null;
  const r = a.getBoundingClientRect();
  return [r.left, r.top, r.width, r.height].map((v) => Math.round(v)).join(',');
})()`;

const READ_LANDING = `(() => {
  const q = document.querySelector('.board-detail-panel .board-decide');
  if (!q) return null;
  const r = q.getBoundingClientRect();
  return { queueTop: Math.round(r.top), viewport: innerHeight };
})()`;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'doc-review-marks-'));
  let handle: ServerHandle | undefined;
  try {
    const widgetDist = join(dir, 'widget');
    await buildWidget(widgetDist);
    step('build the app bundles');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`app build failed:\n${built.stderr}`);
    const dataDir = join(dir, 'data');
    handle = createServer({
      port: 0,
      dataDir,
      widgetDistDir: widgetDist,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
      spawnerAgentId: null,
    });
    const server = handle;
    const base = `http://127.0.0.1:${server.port}`;
    const ws = server.tasks.createWorkspace('Harborlight').id;
    const post = async (path: string, body: unknown): Promise<unknown> => {
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return r.json();
    };
    const make = (title: string): string => {
      const made = server.tasks.createTask(ws, {
        title,
        body: 'Alice can read the timetable so that the ferry runs.',
        actor: ALICE,
      });
      if (!made.ok) throw new Error(`the task ${title} was refused`);
      return made.task.id;
    };
    const file = (taskId: string, headline: string, detail?: string): string => {
      const added = server.tasks.addReviewItem(
        taskId,
        { shape: 'review', headline, ...(detail ? { detail } : {}) },
        { actor: LEAD },
      );
      if (!added.ok) throw new Error(`the item on ${taskId} was refused`);
      return added.item.id;
    };

    const mockPath = join(dir, 'ferry.html');
    writeFileSync(mockPath, '<!doctype html><title>Riverbend ferry page</title><p>Ferry</p>');
    const mock = (
      (await post(`/workspaces/${ws}/docs`, {
        docId: 'riverbend-ferry-page',
        type: 'mockup',
        sourceUrl: mockPath,
        title: 'Riverbend ferry page',
      })) as { docId: string }
    ).docId;
    await post(`/workspaces/${ws}/docs:attach`, { docId: mock });

    const waiting = make('Check the Riverbend timetable');
    const plain = make('Paint the Saltmarsh slipway');
    const layout = make('Lay out the Riverbend ferry page');
    const item = file(waiting, 'Is the Saltmarsh stop ten minutes later now?');
    file(
      layout,
      'Is the ferry page readable at phone width?',
      `Check [the page](/workspaces/${ws}/mockups/${mock}) at 430px.`,
    );
    // Related links sit above the review queue in the panel, so a task with
    // several opens with its queue below the fold on a phone — which is what
    // makes landing on it a thing a reader would notice.
    for (let i = 1; i <= 24; i += 1) {
      server.tasks.linkRef(waiting, { kind: 'url', url: `https://example.com/harborlight-${i}` });
    }

    const docPath = join(dir, 'status.md');
    const taskLink = (id: string): string => `${base}/workspaces/${ws}?task=${id}`;
    writeFileSync(
      docPath,
      [
        '# Harborlight status',
        '',
        `- Timetable: [Check the Riverbend timetable](${taskLink(waiting)})`,
        `- Slipway: [Paint the Saltmarsh slipway](${taskLink(plain)})`,
        `- Mock: [Riverbend ferry page](${base}/workspaces/${ws}/mockups/${mock})`,
        '',
      ].join('\n'),
    );
    const doc = (
      (await post(`/workspaces/${ws}/docs`, {
        docId: 'harborlight-status',
        type: 'markdown',
        sourceUrl: docPath,
        title: 'Harborlight status',
      })) as { docId: string }
    ).docId;
    await post(`/workspaces/${ws}/docs:attach`, { docId: doc });
    const docUrl = `${base}/workspaces/${ws}/docs/${doc}`;

    const shotDir = process.env.CW_SHOT_DIR;
    const widths: ReviewMarksWidthRun[] = [];
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      step(`doc at ${width}`);
      const cdp = await openBrowser(width, height);
      await go(cdp, docUrl);
      const read = async (id: string): Promise<LinkRead | null> =>
        (await cdp.evaluate(readLink(id))) as LinkRead | null;
      // Landed: the plain task's chip is drawn, so the one lookup answered.
      await until('the plain task’s chip', async () => {
        const got = await read(plain);
        return got && got.length > 0 ? got : null;
      });
      const links = {
        waiting: await read(waiting),
        plain: await read(plain),
        mock: await until(
          'the mock’s mark',
          async () => {
            const got = await read(mock);
            return got && got.length > 0 ? got : null;
          },
          5000,
        ).catch(() => read(mock)),
      };
      if (shotDir) {
        const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
          data: string;
        };
        writeFileSync(
          join(shotDir, `review-markers-${width}.png`),
          Buffer.from(png.data, 'base64'),
        );
      }
      const run: ReviewMarksWidthRun = { width, links };
      if (width === 430) {
        step('open the waiting task from its link');
        let navigatedTo = '';
        cdp.on('Page.frameNavigated', (p) => {
          const frame = p.frame as { url: string; parentId?: string };
          if (!frame.parentId) navigatedTo = new URL(frame.url).search;
        });
        const at = (await cdp.evaluate(`(() => {
          const a = [...document.querySelectorAll('.ProseMirror a[href]')]
            .find((x) => (x.getAttribute('href') || '').includes(${JSON.stringify(waiting)}));
          a.scrollIntoView({ block: 'center' });
          const r = a.getBoundingClientRect();
          return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 };
        })()`)) as { x: number; y: number };
        const navigated = cdp.once('Page.loadEventFired');
        for (const type of ['mousePressed', 'mouseReleased'] as const) {
          await cdp.send('Input.dispatchMouseEvent', {
            type,
            x: at.x,
            y: at.y,
            button: 'left',
            clickCount: 1,
          });
        }
        await navigated;
        // Read once the panel has settled on where it landed.
        const settle = async (): Promise<Landing | null> => {
          let last = '';
          return until('the panel’s review queue', async () => {
            const read = (await cdp.evaluate(READ_LANDING)) as Omit<Landing, 'opened'> | null;
            const got = read ? { ...read, opened: navigatedTo } : null;
            if (!got) return null;
            const key = JSON.stringify(got);
            if (key !== last) {
              last = key;
              await sleep(150);
              return null;
            }
            return got;
          });
        };
        const fromLink = await settle().catch(() => null);
        if (shotDir) {
          const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
            data: string;
          };
          writeFileSync(
            join(shotDir, 'review-markers-430-landed.png'),
            Buffer.from(png.data, 'base64'),
          );
        }
        step('the control: the same task from a plain address');
        await go(cdp, taskLink(waiting));
        const plainOpen = await settle().catch(() => null);
        run.landing = { fromLink, plainOpen };

        step('live: answer the item elsewhere, with the doc open');
        await go(cdp, docUrl);
        await until('the waiting task’s mark', async () => {
          const got = await read(waiting);
          return got?.some((c) => c.startsWith('ws-review-mark')) ? got : null;
        });
        const boxBefore = (await cdp.evaluate(boxOf(waiting))) as string | null;
        const answered = server.tasks.answerTaskReview(waiting, item, 'Yes, ten minutes later.', {
          actor: ALICE,
        });
        if (!answered.ok) throw new Error('the answer was refused');
        const droppedInTime = await until(
          'the mark to go',
          async () =>
            (await read(waiting))?.some((c) => c.startsWith('ws-review-mark')) ? null : true,
          1000,
        ).catch(() => false);
        await until(
          'the mark to go (late)',
          async () =>
            (await read(waiting))?.some((c) => c.startsWith('ws-review-mark')) ? null : true,
          5000,
        ).catch(() => false);
        run.live = {
          droppedInTime,
          waiting: await read(waiting),
          mock: await read(mock),
          boxBefore,
          boxAfter: (await cdp.evaluate(boxOf(waiting))) as string | null,
        };
      }
      widths.push(run);
      cdp.close();
    }
    process.stdout.write(`\n${JSON.stringify({ widths } satisfies ReviewMarksRun)}\n`);
  } finally {
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

setTimeout(() => {
  step('gave up after 170s');
  void Promise.all(browsers.map((b) => stopBrowser(b.proc, b.profile))).finally(() =>
    process.exit(3),
  );
}, 170_000).unref();
await main();
process.exit(0);
