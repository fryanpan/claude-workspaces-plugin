#!/usr/bin/env bun
/**
 * Opens a board in headless Chromium against a real server and reports every
 * estimate a person can see on it: on the board, on Home, on a task's page
 * and on the review queue, at 1180x820 and at 430x932. Then turns "Show
 * estimates" on from the settings page of one tab and reads how soon another
 * open tab shows the estimates, and turns it off again the same way (Bryan,
 * 1 Nov: "default to having the setting off on all boards and hide all
 * estimation stuff on all screens behind that setting").
 *
 * The board is created fresh and never sets the setting, so the first
 * readings are a board on the default. Its tickets carry real estimates (the
 * scorer is a stub that answers at once), so an empty reading means the
 * setting hid them, not that there was nothing to hide. Each page also reports
 * a positive control — the goal, the task or the review item it must show —
 * so a page that never mounted reads as a failure rather than as clean.
 *
 * Spawned by `packages/workspaces-app/test/show-estimates-browser.test.ts`,
 * which reads the JSON this prints on its last line.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was read off the running page.
 */
import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Cdp,
  launchChrome,
  pageSocketUrl,
  stopBrowser,
  withTimeout,
} from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedGoalsOverHttp } from './goal-seed.ts';
import { waitFor } from './wait-for.ts';

const PERSON = { id: 'user-alice', name: 'Alice', kind: 'human' };
const AGENT = { id: 'agent-riverbend', name: 'Riverbend Bot', kind: 'agent' };
const GOAL_TITLE = 'Open the Harborlight ferry route';
const TASK_TITLE = 'Chart the Saltmarsh channel';
const HEADLINE = 'May I publish the Saltmarsh channel chart?';

/** What one page showed. */
export interface PageReading {
  /** The page's positive control: what it must show once mounted. */
  kept: boolean;
  /** Every estimate the page showed, as selectors and phrases. Empty is off. */
  estimates: string[];
}

export type Size = 'ipad' | 'phone';
export type Surface = 'board' | 'home' | 'task' | 'review';

/** How one live flip read on the other tab. */
export interface FlipReading {
  /** The other tab was in the starting state when the flip was made, so
   *  reaching the expected one is a change rather than where it already was. */
  startedOpposite: boolean;
  /** The other tab reached the expected state inside the 1s bound. */
  within1s: boolean;
  /** How long it took, for the report. Not asserted on. */
  ms: number;
}

export interface ShowEstimatesReading {
  /** A board that never set it. */
  off: Record<Size, Record<Surface, PageReading>>;
  /** The same board, turned on from the settings page. */
  on: Record<Size, Record<Surface, PageReading>>;
  /** The settings row was found, drawn and could be changed by this reader. */
  toggle: { found: boolean; editable: boolean };
  /** Turned on in one tab: the board in the other tab drew its goal strip. */
  flipOn: FlipReading;
  /** Turned off in one tab: the task page in the other lost Hands-on. */
  flipOff: FlipReading;
  errors: string[];
}

const SIZES = {
  ipad: { width: 1180, height: 820 },
  phone: { width: 430, height: 932 },
} as const;

/** Elements that are only ever an estimate, and the phrases only an estimate
 *  says. A visible match of either is an estimate on screen. */
const ESTIMATE_SELECTORS = ['.board-goal-effort', '.board-goal-bar', '.review-sizes'];
const ESTIMATE_PHRASES =
  /\b(hands-on|wall clock|projected finish|not scored yet|scoring failed|estimate only)\b/gi;

const step = (what: string): void => {
  process.stderr.write(`[show-estimates-browser-driver] ${what}\n`);
};

/** Page-side: the positive control, and every estimate drawn. */
function readExpr(keptText: string): string {
  return `(() => {
    const vis = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    };
    const text = document.body.innerText || '';
    const found = ${JSON.stringify(ESTIMATE_SELECTORS)}.filter((sel) =>
      [...document.querySelectorAll(sel)].some(vis),
    );
    const phrases = [...new Set((text.match(${ESTIMATE_PHRASES}) || []).map((p) => p.toLowerCase()))];
    return { kept: text.includes(${JSON.stringify(keptText)}), estimates: [...found, ...phrases] };
  })()`;
}

/** A first visit asks for a name before some pages mount. */
const ANSWER_IDENTITY = `(() => {
  const inp = document.querySelector('.identity-prompt input, [id^=identity] input, #identity-name');
  if (!inp) return false;
  inp.value = 'Alice';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  const go = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Continue');
  if (go) go.click();
  return true;
})()`;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'show-estimates-browser-'));
  let handle: ServerHandle | undefined;
  let browser: { proc: ChildProcess; profile: string } | undefined;
  try {
    step('build the client');
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      [
        'run',
        join(import.meta.dirname, '../../workspaces-app/scripts/build.ts'),
        '--outdir',
        appDist,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`client build failed:\n${built.stderr}`);

    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
      // Every ticket is scored at once, so the estimates exist to be hidden.
      effortEstimator: async () => ({ handsOnSeconds: 1_800, wallClockSeconds: 7_200 }),
    });
    const local = `http://127.0.0.1:${handle.port}`;
    const call = async (
      path: string,
      body: unknown,
      method = 'POST',
    ): Promise<Record<string, unknown>> => {
      const r = await fetch(`${local}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return (await r.json()) as Record<string, unknown>;
    };

    step('seed a board with a goal, scored tickets and a review item');
    const ws = ((await call('/workspaces', { name: 'Riverbend' })) as { workspace: { id: string } })
      .workspace.id;
    const goals = await seedGoalsOverHttp(local, ws, [{ key: 'ferry', title: GOAL_TITLE }], PERSON);
    const goalId = goals.ferry;
    const taskIds: string[] = [];
    for (const title of [TASK_TITLE, 'Survey the Harborlight pier']) {
      const created = (await call(`/workspaces/${ws}/tasks`, {
        title,
        body: 'Alice can read the chart so that the ferry keeps to the channel.',
        goal: goalId,
        author: AGENT,
      })) as { task: { id: string } };
      taskIds.push(created.task.id);
    }
    const taskId = taskIds[0] ?? '';
    const server = handle;
    await waitFor(() => server.tasks.getTask(taskId)?.effortEstimate?.status === 'ok', {
      timeout: 20_000,
      describe: 'the ticket scored',
    });
    await call(`/workspaces/${ws}/tasks/${taskId}/review-items`, {
      review: {
        shape: 'decision',
        headline: HEADLINE,
        detail: 'The chart is drawn and checked against the Harborlight survey.',
        options: [
          { id: 'o-yes', label: 'Publish it' },
          { id: 'o-no', label: 'Wait' },
        ],
      },
      author: AGENT,
    });

    step('launch Chrome');
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs(SIZES.ipad, profile),
      STARTUP_TIMEOUT_MS,
      `show-estimates-browser-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const errors: string[] = [];
    const open = async (cdp: Cdp): Promise<Cdp> => {
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      cdp.on('Runtime.exceptionThrown', (p) => {
        const d = (p as { exceptionDetails?: { exception?: { description?: string } } })
          .exceptionDetails;
        errors.push(d?.exception?.description?.split('\n')[0] ?? 'exception');
      });
      return cdp;
    };
    const tabA = await open(await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS)));
    const second = (await (
      await fetch(`http://127.0.0.1:${b.port}/json/new?about:blank`, { method: 'PUT' })
    ).json()) as { webSocketDebuggerUrl: string };
    const tabB = await open(await Cdp.connect(second.webSocketDebuggerUrl));
    const ev = <T>(cdp: Cdp, expr: string) => cdp.evaluate(expr) as Promise<T>;

    const go = async (cdp: Cdp, url: string, size: Size, keptText: string): Promise<void> => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        ...SIZES[size],
        deviceScaleFactor: 1,
        mobile: size === 'phone',
      });
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await withTimeout(loaded, 30_000, `${url} to load`);
      await waitFor(
        async () => {
          await ev(cdp, ANSWER_IDENTITY).catch(() => false);
          return (await ev<PageReading>(cdp, readExpr(keptText)).catch(() => null))?.kept === true;
        },
        { timeout: 20_000, describe: `${keptText} on ${url} at ${size}` },
      ).catch(() => undefined);
    };

    const boardUrl = `${local}/workspaces/${ws}`;
    const PAGES: Record<Surface, { url: string; kept: string }> = {
      board: { url: boardUrl, kept: GOAL_TITLE },
      home: { url: `${boardUrl}/home`, kept: HEADLINE },
      task: { url: `${boardUrl}?task=${encodeURIComponent(taskId)}`, kept: TASK_TITLE },
      review: { url: `${local}/review`, kept: HEADLINE },
    };
    /** Read every surface at both sizes. `settle` waits for an estimate to
     *  appear first, which is what a shown page is expected to draw. */
    const readAll = async (expectShown: boolean) => {
      const out = {} as Record<Size, Record<Surface, PageReading>>;
      for (const size of ['ipad', 'phone'] as const) {
        out[size] = {} as Record<Surface, PageReading>;
        for (const surface of ['board', 'home', 'task', 'review'] as const) {
          step(`${surface} at ${size} (${expectShown ? 'on' : 'off'})`);
          const page = PAGES[surface];
          await go(tabA, page.url, size, page.kept);
          const expr = readExpr(page.kept);
          if (expectShown && (surface === 'board' || surface === 'task')) {
            await waitFor(async () => (await ev<PageReading>(tabA, expr)).estimates.length > 0, {
              timeout: 10_000,
              describe: `an estimate on ${surface} at ${size}`,
            }).catch(() => undefined);
          }
          out[size][surface] = await ev<PageReading>(tabA, expr);
        }
      }
      return out;
    };

    const off = await readAll(false);

    step('two tabs: settings in one, the board in the other');
    // The other tab reaches the server over IPv6 loopback, a second host to
    // Chrome. Chrome holds six HTTP/1.1 connections per host, and two open
    // boards' streams fill them, so on one host the settings page's members
    // read queues behind them — a fact about this loopback test, not about a
    // page served over HTTP/2.
    const otherBase = `http://[::1]:${handle.port}/workspaces/${ws}`;
    await go(tabB, otherBase, 'ipad', GOAL_TITLE);
    await go(tabA, boardUrl, 'ipad', GOAL_TITLE);
    const toggleExpr = `(() => { const t = document.getElementById('board-show-estimates');
      return t ? { found: t.getBoundingClientRect().width > 0, editable: !t.disabled } : { found: false, editable: false }; })()`;
    // Open settings until its row is drawn (the opener is wired after the
    // board first paints), then wait for the members read to say this reader
    // owns the board, which is what makes the row editable.
    const openSettings = `(() => { const t = document.getElementById('board-show-estimates');
      if (t && t.getBoundingClientRect().width > 0) return true;
      const n = document.getElementById('board-nav-settings'); const g = document.getElementById('board-settings');
      const vis = (e) => e && e.getBoundingClientRect().width > 0;
      (vis(n) ? n : g)?.click(); return false; })()`;
    await waitFor(
      async () =>
        (await ev<boolean>(tabA, openSettings)) &&
        (await ev<{ editable: boolean }>(tabA, toggleExpr)).editable,
      { timeout: 20_000, describe: 'the settings row editable' },
    ).catch(() => undefined);
    const toggle = await ev<{ found: boolean; editable: boolean }>(tabA, toggleExpr);
    const clickToggle = `(() => { document.getElementById('board-show-estimates')?.click(); return true; })()`;
    // The box is disabled until its write answers, and the other tab can see
    // the change before that answer gets here. A click then does nothing.
    const toggleFree = `!document.getElementById('board-show-estimates')?.disabled`;
    const press = async (): Promise<void> => {
      await waitFor(() => ev<boolean>(tabA, toggleFree), {
        timeout: 10_000,
        describe: 'the box free',
      }).catch(() => undefined);
      await ev(tabA, clickToggle);
    };
    const flip = async (other: Cdp, expr: string): Promise<FlipReading> => {
      const startedOpposite = !(await ev<boolean>(other, expr));
      await press();
      const t0 = Date.now();
      const within1s = await waitFor(async () => ev<boolean>(other, expr), {
        timeout: 1_000,
        interval: 20,
        describe: 'the other tab',
      })
        .then(() => true)
        .catch(() => false);
      return { startedOpposite, within1s, ms: Date.now() - t0 };
    };
    const stripShown = `(() => [...document.querySelectorAll('.board-goal-effort')].some((e) => e.getBoundingClientRect().width > 0))()`;
    const flipOn = await flip(tabB, stripShown);
    // The other tab on a task's page while estimates are on: Hands-on shows,
    // then goes when the first tab turns them off.
    await go(tabB, `${otherBase}?task=${encodeURIComponent(taskId)}`, 'ipad', TASK_TITLE);
    const handsOn = '/hands-on/i.test(document.body.innerText)';
    await waitFor(async () => ev<boolean>(tabB, handsOn), {
      timeout: 10_000,
      describe: 'Hands-on on the task page',
    }).catch(() => undefined);
    const flipOff = await flip(tabB, `!${handsOn}`);
    // Back on for the shown readings, through the same row.
    await press();
    await waitFor(
      async () => {
        const r = await fetch(`${local}/workspaces/${ws}/settings`);
        return ((await r.json()) as { showEstimates?: boolean }).showEstimates === true;
      },
      { timeout: 10_000, describe: 'the setting back on' },
    ).catch(() => undefined);

    const on = await readAll(true);
    tabA.close();
    tabB.close();
    const reading: ShowEstimatesReading = { off, on, toggle, flipOn, flipOff, errors };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
