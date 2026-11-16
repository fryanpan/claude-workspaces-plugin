#!/usr/bin/env bun
/**
 * M10 in two real browsers against a real server: Alice, the board's owner,
 * and Bob, a member, each have the board open. Bob opens Messages and picks
 * Alice's channel. Alice opens Messages, picks Bob, and sends; the reading
 * is whether Bob's already-open board shows the line within 1s, with no
 * reload. Then Bob closes the chat and reopens it, and it is still on
 * Alice's channel.
 *
 * Each person has their own Chrome (their own profile, so their own cookie
 * jar) holding the session cookie the server's sign-in would have set,
 * signed with the data dir's own key. `--shots <dir>` also saves each page
 * with the channel list open, at the size the run used.
 *
 * Spawned by `packages/workspaces-app/test/messages-browser.test.ts`, which
 * reads the JSON this prints on its last line.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was read off the running server and
 * the pages.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
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
import { registerOwnerIdentity, resetOwnerIdentities } from '../src/actor-identity.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { signedInPerson } from './signed-in-person.ts';
import { waitFor } from './wait-for.ts';

const ALICE = 'alice@harborlight.example';
const BOB = 'bob@riverbend.example';
const LINE = 'Bob, is the Riverbend tide table ready?';

export interface MessagesReading {
  /** Both pages showed the Messages item. */
  navShown: { alice: boolean; bob: boolean };
  /** Alice's channel list, as her picker drew it. */
  aliceChannels: string[];
  /** Bob's already-open chat showed Alice's line within 1s of her send. */
  arrivedWithinOneSecond: boolean;
  /** Bob's chat after a close and a reopen: its heading and whether the line
   *  is still there. */
  reopened: { heading: string; hasLine: boolean };
  /** Alice's own chat shows what she sent. */
  aliceShowsLine: boolean;
  errors: string[];
}

const step = (what: string): void => {
  process.stderr.write(`[messages-browser-driver] ${what}\n`);
};

/** Read or act inside the chat's shadow root. */
const inChat = (body: string): string => `(() => {
  const root = document.querySelector('[data-lead-chat="layer"]')?.shadowRoot;
  if (!root) return null;
  ${body}
})()`;

async function main(): Promise<void> {
  const shotsAt = process.argv.indexOf('--shots');
  const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : undefined;
  const sizeAt = process.argv.indexOf('--size');
  const [width, height] = (sizeAt > 0 ? (process.argv[sizeAt + 1] ?? '') : '1180x820')
    .split('x')
    .map(Number) as [number, number];
  const dir = mkdtempSync(join(tmpdir(), 'messages-browser-'));
  let handle: ServerHandle | undefined;
  const browsers: Array<{ proc: ChildProcess; profile: string }> = [];
  try {
    step('build the board client');
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
    if (built.status !== 0) throw new Error(`board client build failed:\n${built.stderr}`);

    const dataDir = join(dir, 'data');
    handle = createServer({ port: 0, dataDir, markdownAppDistDir: appDist });
    const base = `http://127.0.0.1:${handle.port}`;
    const board = handle.tasks.createWorkspace('Harborlight').id;
    handle.shareLinks.addToAudience(board, [BOB], 'Alice');
    const alice = signedInPerson(handle, dataDir, base, { email: ALICE, name: 'Alice' });
    registerOwnerIdentity(alice.user.id);
    const bob = signedInPerson(handle, dataDir, base, { email: BOB, name: 'Bob' });

    const errors: string[] = [];
    const open = async (who: string, cookie: string): Promise<Cdp> => {
      step(`launch Chrome for ${who}`);
      const b = await launchChrome(
        resolveChromeBin(undefined),
        (profile) => chromeLaunchArgs({ width, height }, profile),
        STARTUP_TIMEOUT_MS,
        `messages-${who}-${process.pid}`,
        (started) => {
          browsers.push(started);
        },
      );
      const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
      await cdp.send('Page.enable');
      await cdp.send('Network.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width <= 1100,
      });
      cdp.on('Runtime.exceptionThrown', (p) => {
        const d = (p as { exceptionDetails?: { exception?: { description?: string } } })
          .exceptionDetails;
        errors.push(`${who}: ${d?.exception?.description?.split('\n')[0] ?? 'exception'}`);
      });
      const [name, value] = cookie.split(/=(.*)/s);
      await cdp.send('Network.setCookie', { name, value, url: base, httpOnly: true });
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `${base}/workspaces/${board}` });
      await withTimeout(loaded, 30_000, `${who}'s board to load`);
      return cdp;
    };
    const ev = <T>(cdp: Cdp, expr: string) => cdp.evaluate(expr) as Promise<T>;
    const navShown = (cdp: Cdp) =>
      waitFor(
        () =>
          ev<boolean>(
            cdp,
            `(() => { const b = document.getElementById('board-nav-messages'); return !!b && !b.hidden; })()`,
          ).catch(() => false),
        { timeout: 20_000, describe: 'the Messages item' },
      )
        .then(() => true)
        .catch(() => false);
    const openMessages = (cdp: Cdp) =>
      ev(cdp, `document.getElementById('board-nav-messages').click()`);
    const pick = async (cdp: Cdp, name: string) => {
      await ev(cdp, inChat(`root.querySelector('.lc-chan-btn').click(); return true;`));
      await waitFor(
        () =>
          ev<boolean>(
            cdp,
            inChat(`const row = [...root.querySelectorAll('[data-chan]')]
              .find((r) => r.querySelector('.lc-chan-name')?.textContent === ${JSON.stringify(name)});
            if (!row) return false; row.click(); return true;`),
          ),
        { timeout: 10_000, describe: `${name}'s channel row` },
      );
    };
    const listHas = (cdp: Cdp, text: string) =>
      ev<boolean>(
        cdp,
        inChat(
          `return root.querySelector('.lc-list')?.textContent.includes(${JSON.stringify(text)}) ?? false;`,
        ),
      );
    const shoot = async (cdp: Cdp, name: string) => {
      if (!shots) return;
      mkdirSync(shots, { recursive: true });
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
        data: string;
      };
      writeFileSync(join(shots, `${name}-${width}.png`), Buffer.from(shot.data, 'base64'));
    };

    const bobPage = await open('bob', bob.headers.cookie ?? '');
    const alicePage = await open('alice', alice.headers.cookie ?? '');
    const shown = { alice: await navShown(alicePage), bob: await navShown(bobPage) };

    step('Bob opens Messages on Alice');
    await openMessages(bobPage);
    await pick(bobPage, 'Alice');

    step('Alice opens Messages, picks Bob and sends');
    await openMessages(alicePage);
    await ev(alicePage, inChat(`root.querySelector('.lc-chan-btn').click(); return true;`));
    const aliceChannels = await waitFor(
      () =>
        ev<string[] | null>(
          alicePage,
          inChat(`const rows = [...root.querySelectorAll('.lc-chan-name')].map((r) => r.textContent);
          return rows.length > 1 ? rows : null;`),
        ),
      { timeout: 10_000, describe: "Alice's channel list" },
    );
    await shoot(alicePage, 'alice-channels');
    await ev(alicePage, inChat(`root.querySelector('.lc-chan-btn').click(); return true;`));
    await pick(alicePage, 'Bob');
    await ev(
      alicePage,
      inChat(`const f = root.querySelector('textarea');
      f.value = ${JSON.stringify(LINE)};
      f.dispatchEvent(new Event('input', { bubbles: true }));
      f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;`),
    );
    const arrived = await waitFor(() => listHas(bobPage, LINE), {
      timeout: 1000,
      interval: 10,
      describe: "Alice's line on Bob's open board",
    })
      .then(() => true)
      .catch(() => false);
    await shoot(bobPage, 'bob-received');
    const aliceShowsLine = await waitFor(() => listHas(alicePage, LINE), { timeout: 5000 })
      .then(() => true)
      .catch(() => false);

    step('Bob closes and reopens the chat');
    await ev(bobPage, inChat(`root.querySelector('.lc-close').click(); return true;`));
    await openMessages(bobPage);
    const reopened = {
      heading:
        (await ev<string | null>(
          bobPage,
          inChat(`return root.querySelector('.lc-chan-btn h2')?.textContent ?? null;`),
        )) ?? '',
      hasLine: await listHas(bobPage, LINE),
    };

    for (const c of [alicePage, bobPage]) c.close();
    const reading: MessagesReading = {
      navShown: shown,
      aliceChannels,
      arrivedWithinOneSecond: arrived,
      reopened,
      aliceShowsLine,
      errors,
    };
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    for (const b of browsers) await stopBrowser(b.proc, b.profile);
    await handle?.stop();
    resetOwnerIdentities();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
