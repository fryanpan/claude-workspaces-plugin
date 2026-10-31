#!/usr/bin/env bun
/**
 * The owner taps each entry of Home's section bar on a phone, in headless
 * Chromium against a real server and the real client build, and then opens
 * the same page at 1180x820.
 *
 * Signed in on loopback with the session cookie the emailed-code sign-in sets
 * (signed with the data dir's own key). Thirty boards make the page long
 * enough to scroll; an agent files one review item and the inbox is set up,
 * so every section has content. At 430x932 with touch, the driver scrolls the
 * section out of view, taps its entry with a trusted touch, and reads where
 * the section landed relative to the bar. It reads the bar's entries before
 * and after the taps, to show none moved or resized. At 1180x820 it reads
 * whether the bar takes any space at all.
 *
 * Spawned by `packages/workspaces-app/test/home-nav-browser.test.ts`, which
 * reads the JSON this prints on its last line.
 */
import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';

const OWNER_EMAIL = 'owner@harborlight.test';
const AGENT = { id: 'agent-riverbend', name: 'Riverbend Bot', kind: 'agent' };
const PLACES = ['Harborlight', 'Riverbend', 'Saltmarsh'];

export interface Tap {
  label: string;
  /** The section's top before the tap, and after, in viewport px. */
  before: number;
  after: number;
  /** The bar's bottom edge after the tap, in viewport px. */
  barBottom: number;
  innerHeight: number;
}

export interface HomeNavReading {
  phone: {
    /** The bar's entries, in order. */
    labels: string[];
    /** Each entry's left edge, width and height, before any tap and after
     *  the last one. Its top is left out: the bar sticks as the page scrolls. */
    boxesBefore: string[];
    boxesAfter: string[];
    taps: Tap[];
  };
  desktop: {
    display: string;
    height: number;
  };
  errors: string[];
}

const step = (what: string): void => {
  process.stderr.write(`[home-nav-browser-driver] ${what}\n`);
};

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'home-nav-browser-'));
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

    const dataDir = join(dir, 'data');
    mkdirSync(join(dataDir, 'inbox'), { recursive: true });
    writeFileSync(
      join(dataDir, 'inbox', 'config.json'),
      JSON.stringify({
        readerAgentId: 'agent-reader',
        slack: [{ workspace: 'harbor', label: 'Harbor', host: 'harborlight' }],
      }),
    );
    handle = createServer({
      port: 0,
      dataDir,
      markdownAppDistDir: appDist,
      ownerEmail: OWNER_EMAIL,
      inboxTransport: { ready: () => false, send: async () => ({ ok: false, error: 'unused' }) },
    });
    const local = `http://127.0.0.1:${handle.port}`;
    const boards: string[] = [];
    for (let i = 0; i < 30; i++) {
      boards.push(handle.tasks.createWorkspace(`${PLACES[i % 3]} ${Math.floor(i / 3) + 1}`).id);
    }
    const agentPost = async (path: string, body: unknown) => {
      const r = await fetch(`${local}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return (await r.json()) as Record<string, { id: string }>;
    };
    const task = (
      await agentPost(`/workspaces/${boards[0]}/tasks`, {
        title: 'Agent can ship the Saltmarsh notes so that Friday holds',
        author: AGENT,
      })
    ).task;
    await agentPost(`/workspaces/${boards[0]}/tasks/${task?.id}/review-items`, {
      author: AGENT,
      review: {
        shape: 'decision',
        headline: 'Ship the Saltmarsh release notes today?',
        detail: 'They are drafted and reviewed. Shipping today beats the Friday freeze.',
        options: [
          { id: 'yes', label: 'Ship today' },
          { id: 'no', label: 'Hold for Monday' },
        ],
      },
    });

    step('launch Chrome');
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 430, height: 932 }, profile),
      STARTUP_TIMEOUT_MS,
      `home-nav-browser-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    const errors: string[] = [];
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = (p as { exceptionDetails?: { exception?: { description?: string } } })
        .exceptionDetails;
      errors.push(d?.exception?.description?.split('\n')[0] ?? 'exception');
    });
    const ev = <T>(expr: string) => cdp.evaluate(expr) as Promise<T>;
    const open = async () => {
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `${local}/` });
      await withTimeout(loaded, 30_000, 'Home to load');
      await waitFor(() => ev<boolean>(`!!document.querySelector('h1')`), {
        timeout: 20_000,
        describe: 'Home',
      });
    };

    const owner = signedInPerson(handle, dataDir, local, { email: OWNER_EMAIL });
    const [name, value] = (owner.headers.cookie ?? '').split(/=(.*)/s);
    await cdp.send('Network.setCookie', {
      name,
      value,
      url: local,
      httpOnly: true,
      sameSite: 'Lax',
    });

    step('phone: 430x932, touch');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 430,
      height: 932,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await open();
    const boxes = () =>
      ev<string[]>(`[...document.querySelectorAll('.home-nav a')].map((a) => {
        const r = a.getBoundingClientRect();
        return [r.left, r.width, r.height].map((n) => Math.round(n)).join(',');
      })`);
    const labels = await ev<string[]>(
      `[...document.querySelectorAll('.home-nav a')].map((a) => a.textContent)`,
    );
    const boxesBefore = await boxes();
    const taps: Tap[] = [];
    // Each section starts out of view: scrolled past for the ones above,
    // at the top for the one below.
    for (const [label, from] of [
      ['Projects', 'top'],
      ['Coach', 'bottom'],
      ['Inbox', 'bottom'],
      ['Review items', 'bottom'],
    ] as const) {
      const sel = await ev<string>(
        `[...document.querySelectorAll('.home-nav a')].find((a) => a.textContent === ${JSON.stringify(label)})?.getAttribute('href') ?? ''`,
      );
      if (!sel) throw new Error(`no ${label} entry`);
      await ev(`window.scrollTo(0, ${from === 'top' ? 0 : 'document.body.scrollHeight'})`);
      const topOf = () =>
        ev<number>(
          `Math.round(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().top)`,
        );
      const before = await topOf();
      const at = await ev<{ x: number; y: number }>(`(() => {
        const a = document.querySelector('.home-nav a[href=${JSON.stringify(sel)}]');
        const r = a.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: at.x, y: at.y }],
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const after = await waitFor(
        async () => {
          const t = await topOf();
          return t !== before ? t : null;
        },
        { timeout: 10_000, describe: `${label} to scroll` },
      );
      taps.push({
        label,
        before,
        after,
        barBottom: await ev<number>(
          `Math.round(document.querySelector('.home-nav').getBoundingClientRect().bottom)`,
        ),
        innerHeight: await ev<number>('innerHeight'),
      });
    }
    const boxesAfter = await boxes();

    step('desktop: 1180x820');
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1180,
      height: 820,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await open();
    const desktop = await ev<HomeNavReading['desktop']>(`(() => {
      const nav = document.querySelector('.home-nav');
      return {
        display: getComputedStyle(nav).display,
        height: nav.getBoundingClientRect().height,
      };
    })()`);

    cdp.close();
    const reading: HomeNavReading = {
      phone: { labels, boxesBefore, boxesAfter, taps },
      desktop,
      errors,
    };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    resetOwnerIdentities();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
