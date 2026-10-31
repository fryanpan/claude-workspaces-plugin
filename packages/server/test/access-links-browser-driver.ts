#!/usr/bin/env bun
/**
 * The owner goes from the workspaces list to the access page and back, in
 * headless Chromium against a real server and the real client build, at
 * 1180x820.
 *
 * Signed in on loopback with the session cookie the emailed-code sign-in
 * sets (signed with the data dir's own key), the driver opens `/`, clicks
 * the "Who has access" link with trusted mouse events, waits for the access
 * page to render, then clicks its back link. It does the same from
 * `/access?ws=<board>`, the address a board's settings link opens, because
 * that is where the back link used to go to the board instead. The control
 * is the same list opened signed out, in the same run: no access link.
 *
 * Spawned by `packages/workspaces-app/test/access-links-browser.test.ts`,
 * which reads the JSON this prints on its last line.
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

export interface AccessLinksReading {
  /** Signed out: how many links to the access page the list shows. */
  signedOutAccessLinks: number;
  /** Where clicking the list's access link landed, and what it showed. */
  fromList: { pathname: string; heading: string };
  /** Where clicking the access page's back link landed, opened plain. */
  backFromPlain: { label: string; pathname: string; heading: string };
  /** The same, opened from a board as `/access?ws=<board>`. */
  backFromBoard: { label: string; pathname: string; heading: string };
  errors: string[];
}

const step = (what: string): void => {
  process.stderr.write(`[access-links-browser-driver] ${what}\n`);
};

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'access-links-browser-'));
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

    step('launch Chrome');
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `access-links-browser-${process.pid}`,
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
    const open = async (path: string) => {
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `${local}${path}` });
      await withTimeout(loaded, 30_000, `${path} to load`);
    };
    /** Click `selector` where a person would, once it is on screen. */
    const click = async (selector: string) => {
      const at = await waitFor(
        () =>
          ev<{ x: number; y: number } | null>(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0
              ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
          })()`).catch(() => null),
        { timeout: 20_000, describe: selector },
      );
      const loaded = cdp.once('Page.loadEventFired');
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {
          type,
          x: at.x,
          y: at.y,
          button: 'left',
          clickCount: 1,
        });
      }
      await withTimeout(loaded, 30_000, `the page after clicking ${selector}`);
    };
    const heading = (sel: string) =>
      waitFor(
        () =>
          ev<string | null>(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`),
        { timeout: 20_000, describe: sel },
      );
    const pathname = () => ev<string>('location.pathname');
    const backOnce = async (path: string) => {
      await open(path);
      // The back link is drawn by the settings bundle, so wait for it.
      const label = await heading('.settings-back');
      await click('.settings-back');
      return { label, pathname: await pathname(), heading: await heading('h1') };
    };

    step('control: the list signed out');
    await open('/');
    await heading('h1');
    const signedOutAccessLinks = await ev<number>(
      `document.querySelectorAll('a[href="/access"]').length`,
    );

    step('sign in as the owner');
    const owner = signedInPerson(handle, dataDir, local, { email: OWNER_EMAIL });
    const [name, value] = (owner.headers.cookie ?? '').split(/=(.*)/s);
    await cdp.send('Network.setCookie', {
      name,
      value,
      url: local,
      httpOnly: true,
      sameSite: 'Lax',
    });

    step('the list to the access page');
    await open('/');
    await click('a[href="/access"]');
    const fromList = {
      pathname: await pathname(),
      heading: await heading('.settings-topbar h1'),
    };

    step('back from the access page, opened plain');
    const backFromPlain = await backOnce('/access');
    step('back from the access page, opened from a board');
    const backFromBoard = await backOnce(`/access?ws=${encodeURIComponent(board)}`);

    cdp.close();
    const reading: AccessLinksReading = {
      signedOutAccessLinks,
      fromList,
      backFromPlain,
      backFromBoard,
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

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
