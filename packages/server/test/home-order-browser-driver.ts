#!/usr/bin/env bun
/**
 * Where the owner's review items and coach section sit on Home, read in
 * headless Chromium against a real server and the real client build, at
 * 1180x820 and at 430x932.
 *
 * Signed in on loopback with the session cookie the emailed-code sign-in sets
 * (signed with the data dir's own key), so the page carries the owner's coach
 * section. An agent files one review item, so the review region has content.
 *
 * Spawned by `packages/workspaces-app/test/home-order-browser.test.ts`, which
 * reads the JSON this prints on its last line.
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
import { resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';

const OWNER_EMAIL = 'owner@harborlight.test';
const AGENT = { id: 'agent-riverbend', name: 'Riverbend Bot', kind: 'agent' };

/** One region's box in viewport px, or null when it is not on the page. */
export type Box = { top: number; bottom: number } | null;

export interface HomeOrderSize {
  width: number;
  height: number;
  review: Box;
  coach: Box;
}

export interface HomeOrderReading {
  sizes: HomeOrderSize[];
  errors: string[];
}

const SIZES = [
  { width: 1180, height: 820, mobile: false },
  { width: 430, height: 932, mobile: true },
];

const step = (what: string): void => {
  process.stderr.write(`[home-order-browser-driver] ${what}\n`);
};

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'home-order-browser-'));
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
      `home-order-browser-${process.pid}`,
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

    const sizes: HomeOrderSize[] = [];
    for (const s of SIZES) {
      step(`home at ${s.width}x${s.height}`);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: s.width,
        height: s.height,
        deviceScaleFactor: 2,
        mobile: s.mobile,
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: s.mobile });
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `${local}/` });
      await withTimeout(loaded, 30_000, 'Home to load');
      await waitFor(() => ev<boolean>(`!!document.querySelector('h1')`), {
        timeout: 20_000,
        describe: 'Home',
      });
      const boxes = await ev<{ review: Box; coach: Box }>(`(() => {
        const box = (id) => {
          const el = document.getElementById(id);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
        };
        return { review: box('landing-review'), coach: box('coach') };
      })()`);
      sizes.push({ width: s.width, height: s.height, ...boxes });
    }
    const reading: HomeOrderReading = { sizes, errors };
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
