#!/usr/bin/env bun
/**
 * Incoming Messages on the front page, driven with real key presses.
 *
 * Boots a server with three fixture rows and opens `/` through the owner's
 * Access door (`inbox-front-page.ts`), at 1180x820, then:
 *
 *  - reads that no line carries the cursor before a key, presses `j` and
 *    reads the cursor on the first line and how it is drawn, presses `j`
 *    again and reads it on the second;
 *  - presses `o` and reads which line opened and its text;
 *  - presses `?` and reads the dialog and the section's height, then Escape;
 *  - presses `e` on the cursor line and reads the Removed fold.
 *
 * Spawned by `inbox-keys-browser.test.ts`, which reads the JSON this prints
 * last. With `INBOX_SHOT_DIR` set it also saves screenshots there at
 * 1180x820 and 430x932: an opened line with its Remove button, and the
 * Removed fold open.
 */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  AUD,
  OWNER_EMAIL,
  OWNER_HOST,
  TEAM,
  accessKeys,
  buildLanding,
  edge,
  poll,
  press,
  seed,
} from './inbox-front-page.ts';

export interface Reading {
  /** What held focus once the page had loaded, before any key. */
  focusAtLoad: string;
  /** The cursor's line before any key; none is the right answer. */
  cursorAtLoad: string | null;
  /** After one `j` the cursor is on the first line, after a second on the
   *  second. */
  firstLine: string | null;
  cursorAfterJ: string | null;
  secondLine: string | null;
  cursorAfterJJ: string | null;
  /** How the cursor line is drawn after the first `j`, beside a line without
   *  it, and whether the line is wholly inside the viewport. */
  cursorLook: Look;
  plainLook: Look;
  cursorInView: boolean;
  /** After `o`: the open line, and its message text once fetched. */
  openAfterO: string | null;
  messageAfterO: string | null;
  /** After `?`: the dialog's label, whether it names `e`, and the section's
   *  height before and after. */
  keysDialog: string | null;
  keysNameE: boolean;
  heightBefore: number;
  heightWithKeys: number;
  /** After Escape: whether any dialog is left. */
  dialogAfterEscape: boolean;
  /** After `e` on the cursor line: the fold's label, and the toast. */
  removedFold: string | null;
  toast: string | null;
  openLinesAfterE: number;
}

const ROWS = '#inbox .inbox-rows > .inbox-row';

/** The computed paint of a line's button, which covers its row: what the
 *  reader sees is this, not the row's own background or shadow. */
export interface Look {
  boxShadow: string;
  backgroundColor: string;
  /** The line's own background, behind the button. */
  lineBackground: string;
  /** The element painted at the line's left edge, 1px in. */
  atLeftEdge: string;
}

const look = (cdp: Cdp, row: string) =>
  cdp.evaluate(`(() => {
    const b = document.querySelector(${JSON.stringify(row)} + " .inbox-line > .board-review-row");
    if (!b) return null;
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + 1, r.top + r.height / 2);
    return { boxShadow: cs.boxShadow, backgroundColor: cs.backgroundColor, lineBackground: getComputedStyle(b.parentElement).backgroundColor, atLeftEdge: hit ? hit.className : "none" };
  })()`) as Promise<Look>;

async function view(cdp: Cdp, width: number, height: number): Promise<void> {
  const mobile = width <= 1100;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
}

async function load(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
  const ready = await poll(
    async () =>
      // startInbox() gives the section focus last thing, once its listeners are on.
      (await cdp.evaluate(
        `!!document.querySelector("${ROWS}") && document.activeElement?.id === "inbox"`,
      ))
        ? true
        : null,
    10_000,
  );
  if (!ready) throw new Error('the section never came up');
}

async function shot(cdp: Cdp, name: string): Promise<void> {
  const dir = process.env.INBOX_SHOT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
    data: string;
  };
  writeFileSync(join(dir, `${name}.png`), Buffer.from(data, 'base64'));
}

const text = (cdp: Cdp, expr: string) => cdp.evaluate(expr) as Promise<string | null>;

async function drive(cdp: Cdp, url: string): Promise<Reading> {
  await view(cdp, 1180, 820);
  await load(cdp, url);
  const focusAtLoad = String(
    await cdp.evaluate(
      '(() => { const a = document.activeElement; return a ? a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") : "none"; })()',
    ),
  );
  const nth = (n: number) =>
    text(cdp, `document.querySelectorAll("${ROWS}")[${n}]?.dataset.row ?? null`);
  const cursorNow = () =>
    text(cdp, `document.querySelector("${ROWS}.inbox-row-cursor")?.dataset.row ?? null`);
  const firstLine = await nth(0);
  const secondLine = await nth(1);
  const cursorAtLoad = await cursorNow();
  await press(cdp, 'j');
  const cursorAfterJ = await poll(async () => {
    const c = await cursorNow();
    return c === firstLine ? c : null;
  }, 3000);
  const cursorLook = await look(cdp, `${ROWS}.inbox-row-cursor`);
  const plainLook = await look(cdp, `${ROWS}:not(.inbox-row-cursor)`);
  const cursorInView = (await cdp.evaluate(`(() => {
    const r = document.querySelector("${ROWS}.inbox-row-cursor")?.getBoundingClientRect();
    return !!r && r.top >= 0 && r.bottom <= innerHeight;
  })()`)) as boolean;
  await shot(cdp, 'cursor-1180x820');
  await press(cdp, 'j');
  const cursorAfterJJ = await poll(async () => {
    const c = await cursorNow();
    return c === secondLine ? c : null;
  }, 3000);
  await press(cdp, 'o');
  const openAfterO = await poll(
    () => text(cdp, `document.querySelector("${ROWS}.inbox-row-open")?.dataset.row ?? null`),
    3000,
  );
  const messageAfterO = await poll(async () => {
    const t = await text(
      cdp,
      'document.querySelector("#inbox .inbox-row-open .inbox-msg")?.textContent ?? null',
    );
    return t && t !== 'Loading…' ? t : null;
  }, 3000);
  await poll(
    async () =>
      (await cdp.evaluate('!!document.querySelector(\'#inbox [data-act="remove"]\')'))
        ? true
        : null,
    3000,
  );
  await shot(cdp, 'opened-1180x820');

  const height = () =>
    cdp.evaluate(
      'document.querySelector("#inbox").getBoundingClientRect().height',
    ) as Promise<number>;
  const heightBefore = await height();
  await press(cdp, '?');
  const keysDialog = await poll(
    () =>
      text(
        cdp,
        'document.querySelector(\'#inbox [role="dialog"]\')?.getAttribute("aria-label") ?? null',
      ),
    3000,
  );
  const keysNameE = (await cdp.evaluate(
    '[...document.querySelectorAll(\'[role="dialog"] dt\')].some((d) => d.textContent === "e")',
  )) as boolean;
  const heightWithKeys = await height();
  await shot(cdp, 'keys-1180x820');
  await press(cdp, 'Escape');
  const dialogAfterEscape = (await cdp.evaluate(
    '!!document.querySelector(\'[role="dialog"]\')',
  )) as boolean;

  await press(cdp, 'e');
  const removedFold = await poll(
    () =>
      text(cdp, 'document.querySelector(\'#inbox [data-fold="removed"]\')?.textContent ?? null'),
    5000,
  );
  const toast = await text(cdp, 'document.querySelector(".inbox-toast span")?.textContent ?? null');
  const openLinesAfterE = (await cdp.evaluate(
    `document.querySelectorAll("${ROWS}:not(.inbox-cleared)").length`,
  )) as number;
  await cdp.evaluate('document.querySelector(\'#inbox [data-fold="removed"]\')?.click()');
  await shot(cdp, 'removed-1180x820');

  if (process.env.INBOX_SHOT_DIR) {
    await view(cdp, 430, 932);
    await load(cdp, url);
    await press(cdp, 'j');
    await shot(cdp, 'cursor-430');
    await press(cdp, 'o');
    await poll(
      async () =>
        (await cdp.evaluate('!!document.querySelector(\'#inbox [data-act="remove"]\')'))
          ? true
          : null,
      3000,
    );
    await shot(cdp, 'opened-430');
    await cdp.evaluate(
      'document.querySelector(\'#inbox [data-fold="removed"]\')?.click(); document.querySelector(\'#inbox [data-fold="removed"]\')?.scrollIntoView({ block: "center" })',
    );
    await shot(cdp, 'removed-430');
  }
  return {
    focusAtLoad,
    cursorAtLoad,
    firstLine,
    cursorAfterJ,
    secondLine,
    cursorAfterJJ,
    cursorLook,
    plainLook,
    cursorInView,
    openAfterO,
    messageAfterO,
    keysDialog,
    keysNameE,
    heightBefore,
    heightWithKeys,
    dialogAfterEscape,
    removedFold,
    toast,
    openLinesAfterE,
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-keys-'));
  let handle: ServerHandle | undefined;
  let proxy: ReturnType<typeof edge> | undefined;
  let browser: { proc: ChildProcess; profile: string } | undefined;
  try {
    const dist = join(dir, 'dist');
    await buildLanding(dist);
    const dataDir = join(dir, 'data');
    seed(dataDir);
    const { jwks, assertion } = accessKeys();
    handle = createServer({
      port: 0,
      dataDir,
      markdownAppDistDir: dist,
      cfAccess: { teamDomain: TEAM, audience: AUD, jwks },
      proxiedTrustedHosts: [OWNER_HOST],
      proxiedTrustedEmails: [OWNER_EMAIL],
      ownerEmail: OWNER_EMAIL,
      // Never the real Keychain: the body read asks whether Send is set up.
      inboxTransport: { ready: () => false, send: async () => ({ ok: false, error: 'unused' }) },
    });
    proxy = edge(`http://127.0.0.1:${handle.port}`, assertion);
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `inbox-keys-${process.pid}-${randomUUID().slice(0, 6)}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const reading = await drive(cdp, `${proxy.origin}/`);
    cdp.close();
    // Last line of stdout: the server logs its own lines above it.
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    await proxy?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
