#!/usr/bin/env bun
/**
 * The keeper's two pages in headless Chromium, with Chrome's virtual
 * authenticator standing in for Touch ID: the enrollment page registers a
 * passkey, and the approval page approves a held `fly apps create` with it.
 *
 * The keeper runs in this process with a recording stand-in for `fly`, so
 * the reading says whether the command ran before the tap (it must not) and
 * after it (it must). Spawned by `keeper-approval-browser.test.ts`,
 * which reads the JSON this prints last.
 *
 * audit: no-text — every value it returns came from the page and the keeper.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlyResult } from '../packages/server/src/keeper/keeper-requests.ts';
import { serveKeeper } from '../packages/server/src/keeper/keeper-serve.ts';
import { hashToken, openKeeperStore } from '../packages/server/src/keeper/keeper-store.ts';
import { Cdp, launchChrome, pageSocketUrl, sleep, stopBrowser } from './headless-chrome.ts';
import { STARTUP_TIMEOUT_MS, chromeLaunchArgs, resolveChromeBin } from './ui-shot-lib.ts';

export interface KeeperBrowserReading {
  enrollStatus: string;
  passkeys: number;
  ranBeforeTap: number;
  approveStatus: string;
  ranAfterTap: string[][];
  appRegistered: boolean;
}

const tmp = mkdtempSync(join(tmpdir(), 'keeper-browser-'));
const dir = join(tmp, 'store');
mkdirSync(dir, { mode: 0o700 });
const store = openKeeperStore(dir);
if ('error' in store) throw new Error(store.error);

const ran: string[][] = [];
const keeper = serveKeeper({
  store,
  port: 0,
  exec: {
    fly: async (args): Promise<FlyResult> => {
      ran.push(args);
      return { status: 0, stdout: 'created\n', stderr: '' };
    },
    cloudflare: async () => ({ status: 500, body: '{}' }),
  },
});

async function statusText(cdp: Cdp, want: RegExp): Promise<string> {
  let last = '';
  for (let i = 0; i < 200; i++) {
    last = String(await cdp.evaluate(`document.getElementById('status')?.textContent ?? ''`));
    if (want.test(last)) return last;
    await sleep(50);
  }
  return last;
}

async function open(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
}

let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
try {
  browser = await launchChrome(
    resolveChromeBin(undefined),
    (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
    STARTUP_TIMEOUT_MS,
    `keeper-browser-${process.pid}`,
  );
  const cdp = await Cdp.connect(await pageSocketUrl(browser.port, STARTUP_TIMEOUT_MS));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  const token = 'browser-enroll-token';
  store.saveEnroll({
    tokenHash: hashToken(token),
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
  });
  await open(cdp, `${keeper.origin}/enroll/browser-driver-link#${token}`);
  await cdp.evaluate(`document.getElementById('enroll').click()`);
  const enrollStatus = await statusText(cdp, /Registered|Not registered/);

  const held = (await (
    await fetch(`http://127.0.0.1:${keeper.port}/v1/fly`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cw-keeper': '1' },
      body: JSON.stringify({ args: ['apps', 'create', 'cw-harborlight'] }),
    })
  ).json()) as { approveUrl: string };
  const ranBeforeTap = ran.length;
  await open(cdp, held.approveUrl);
  await cdp.evaluate(`document.getElementById('approve').click()`);
  const approveStatus = await statusText(cdp, /Approved|Not approved/);

  const reading: KeeperBrowserReading = {
    enrollStatus,
    passkeys: store.passkeys().length,
    ranBeforeTap,
    approveStatus,
    ranAfterTap: ran,
    appRegistered: store.apps().includes('cw-harborlight'),
  };
  cdp.close();
  console.log(JSON.stringify(reading));
} finally {
  if (browser) await stopBrowser(browser.proc, browser.profile);
  await keeper.stop();
  rmSync(tmp, { recursive: true, force: true });
}
