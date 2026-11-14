#!/usr/bin/env bun
/**
 * The owner opens Home and the Coach board, in headless Chromium against a
 * real server and the real client build, at 1180x820 and at 430x932.
 *
 * Signed in on loopback with the session cookie the emailed-code sign-in sets
 * (signed with the data dir's own key). The page POSTs `/coach/setup` once, so the Coach board and its Learning goals doc exist, and an
 * agent files one review item so Home's review region has content. Every
 * page's coach stream is replaced before any script runs with one that offers
 * a moment, so a page that mounts the coach card draws it.
 *
 * At each size it reads, on Home: the review region (the control), any coach
 * region, coach card or Coach nav entry (Bryan: "Coach should not be on home
 * page"). On the Coach board's Library: the coach card and the Learning goals
 * doc. `CW_SHOT_DIR` set: Home and the board are saved there as PNGs.
 *
 * Spawned by `packages/workspaces-app/test/home-coach-browser.test.ts`, which
 * reads the JSON this prints on its last line.
 */
import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** One region's box in viewport px, or null when it is not on the page. */
export type Box = { top: number; bottom: number } | null;

export interface HomeCoachSize {
  width: number;
  height: number;
  home: {
    review: Box;
    /** The coach section, or null when Home has none. */
    coach: Box;
    coachCards: number;
    navLabels: string[];
    /** Requests Home made to `/coach/…`. The card's first act on mount is a
     *  POST to `/coach/here`, and Home's module has run by its load event. */
    coachRequests: string[];
  };
  coachBoard: {
    /** Requests the board made to `/coach/…` (the control for Home's). */
    coachRequests: string[];
    /** The offered moment's card, drawn. */
    coachCard: boolean;
    /** The Learning goals doc is listed. */
    learningGoals: boolean;
  };
}

export interface HomeCoachReading {
  sizes: HomeCoachSize[];
  errors: string[];
}

const SIZES = [
  { width: 1180, height: 820, mobile: false },
  { width: 430, height: 932, mobile: true },
];

const step = (what: string): void => {
  process.stderr.write(`[home-coach-browser-driver] ${what}\n`);
};

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'home-coach-browser-'));
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
    handle = createServer({
      port: 0,
      dataDir,
      markdownAppDistDir: appDist,
      ownerEmail: OWNER_EMAIL,
    });
    const local = `http://127.0.0.1:${handle.port}`;
    const board = handle.tasks.createWorkspace('Harborlight').id;
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
      await agentPost(`/workspaces/${board}/tasks`, {
        title: 'Agent can ship the Saltmarsh notes so that Friday holds',
        author: AGENT,
      })
    ).task;
    await agentPost(`/workspaces/${board}/tasks/${task?.id}/review-items`, {
      author: AGENT,
      review: {
        shape: 'decision',
        headline: 'Ship the Saltmarsh release notes today?',
        detail: 'They are drafted and reviewed.',
        options: [
          { id: 'yes', label: 'Ship today' },
          { id: 'no', label: 'Hold for Monday' },
        ],
      },
    });

    step('launch Chrome');
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `home-coach-browser-${process.pid}`,
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

    const owner = signedInPerson(handle, dataDir, local, { email: OWNER_EMAIL });
    const [name, value] = (owner.headers.cookie ?? '').split(/=(.*)/s);
    await cdp.send('Network.setCookie', {
      name,
      value,
      url: local,
      httpOnly: true,
      sameSite: 'Lax',
    });

    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const Real = window.EventSource;
        window.EventSource = function (url, init) {
          if (!String(url).startsWith('/coach/stream')) return new Real(url, init);
          const t = new EventTarget();
          t.close = () => {};
          setTimeout(() => {
            const moment = { id: 'cm-harborlight', at: Date.now(), name: 'Coach',
              line: 'Ship the Saltmarsh notes before lunch.', goal: 'Friday holds' };
            t.dispatchEvent(new MessageEvent('coach', { data: JSON.stringify({ type: 'moment', moment }) }));
          }, 50);
          return t;
        };
      })()`,
    });
    let coachRequests: string[] = [];
    cdp.on('Network.requestWillBeSent', (p) => {
      const url = new URL((p as { request: { url: string } }).request.url);
      if (url.pathname.startsWith('/coach/')) coachRequests.push(url.pathname);
    });
    const open = async (path: string) => {
      coachRequests = [];
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `${local}${path}` });
      await withTimeout(loaded, 30_000, `${path} to load`);
    };

    step('set up the coach from the page');
    await open('/');
    const setup = await ev<{ status: number; url?: string }>(`fetch('/coach/setup', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: '{}',
    }).then(async (r) => ({ status: r.status, ...(r.ok ? await r.json() : {}) }))`);
    const coachBoard = setup.url?.match(/^\/workspaces\/([^/]+)\/docs\//)?.[1];
    if (!coachBoard) throw new Error(`coach setup: ${JSON.stringify(setup)}`);
    const shotDir = process.env.CW_SHOT_DIR;
    const shoot = async (name: string) => {
      if (!shotDir) return;
      const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
        data: string;
      };
      writeFileSync(join(shotDir, name), Buffer.from(png.data, 'base64'));
    };

    const sizes: HomeCoachSize[] = [];
    for (const s of SIZES) {
      step(`home at ${s.width}x${s.height}`);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: s.width,
        height: s.height,
        deviceScaleFactor: 2,
        mobile: s.mobile,
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: s.mobile });
      await open('/');
      await waitFor(() => ev<boolean>(`!!document.querySelector('#landing-review .allbar')`), {
        timeout: 20_000,
        describe: 'Home with its review item',
      });
      const homeRead = await ev<Omit<HomeCoachSize['home'], 'coachRequests'>>(`(() => {
        const box = (id) => {
          const el = document.getElementById(id);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
        };
        return {
          review: box('landing-review'),
          coach: box('coach'),
          coachCards: document.querySelectorAll('.coach-card-host').length,
          navLabels: [...document.querySelectorAll('.home-nav .board-nav-item')].map((a) => a.textContent.trim()),
        };
      })()`);
      const home = { ...homeRead, coachRequests: [...coachRequests] };
      await shoot(`home-${s.width}.png`);

      step(`the Coach board at ${s.width}x${s.height}`);
      await open(`/workspaces/${coachBoard}/library`);
      const board = await waitFor(
        async () => {
          const r = await ev<Omit<HomeCoachSize['coachBoard'], 'coachRequests'>>(`({
            coachCard: !!document.querySelector('.coach-card-host')?.shadowRoot?.querySelector('.cw-coach'),
            learningGoals: (() => {
              const tab = [...document.querySelectorAll('#board-library button, #board-library [role=tab]')]
                .find((b) => b.textContent.trim() === 'Recently Created');
              if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
              return document.getElementById('board-library').innerText.includes('Learning goals');
            })(),
          })`);
          return r.coachCard && r.learningGoals ? r : null;
        },
        { timeout: 20_000, describe: 'the coach card and Learning goals on the Coach board' },
      ).catch(() =>
        ev<Omit<HomeCoachSize['coachBoard'], 'coachRequests'>>(`({
          coachCard: !!document.querySelector('.coach-card-host')?.shadowRoot?.querySelector('.cw-coach'),
          learningGoals: document.body.innerText.includes('Learning goals'),
        })`),
      );
      await shoot(`coach-board-${s.width}.png`);
      sizes.push({
        width: s.width,
        height: s.height,
        home,
        coachBoard: { ...board, coachRequests: [...coachRequests] },
      });
    }
    const reading: HomeCoachReading = { sizes, errors };
    process.stdout.write(`${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    resetOwnerIdentities();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
