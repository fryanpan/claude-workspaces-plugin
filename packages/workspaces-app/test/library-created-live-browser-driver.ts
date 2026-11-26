#!/usr/bin/env bun
/**
 * A doc made elsewhere reaches a Library that is ALREADY OPEN on Recently
 * Created, with no reload; and the three recent-files tabs hold one row,
 * unmoved, whichever is chosen, at 1180x820 and at 430. Headless Chromium
 * against a real server and the real client build.
 *
 * The board starts with one whiteboard. The Library is opened on Recently
 * Created (the device's stored tab) and read; then a second whiteboard is
 * made over REST, and the driver polls the open page until it is the first
 * row. A marker set on `window` before the create proves the page that shows
 * it is the page that was open, not a reload.
 *
 * Spawned by `library-created-live-browser.test.ts`, which reads the JSON this
 * prints on its last line. `CW_SHOT_DIR` set: each size is saved there.
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
  withTimeout,
} from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { resetOwnerIdentities } from '../../server/src/actor-identity.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';
import { signedInPerson } from '../../server/test/signed-in-person.ts';

/** One tab as drawn: its label and its box, rounded to the pixel. */
export interface TabBox {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The tab row read once per chosen tab, at one viewport width. */
export interface TabRowReading {
  width: number;
  /** By the tab chosen when read: every tab's box. */
  byChoice: Record<string, TabBox[]>;
  /** The page scrolls sideways. */
  overflow: boolean;
}

export interface LibraryCreatedLiveReading {
  /** Recently Created's names before the create. */
  before: string[];
  /** Recently Created's names once the new doc was drawn, or the last read. */
  after: string[];
  /** The page that drew `after` is the page that was open before the create. */
  samePage: boolean;
  /** Milliseconds from the create's answer to the row on the open page:
   *  reported, never asserted — a loaded runner's clock is not the code's. */
  latencyMs: number | null;
  rows: TabRowReading[];
  errors: string[];
}

const step = (what: string): void => {
  process.stderr.write(`[library-created-live-driver] ${what}\n`);
};

const READ_CREATED = `[...document.querySelectorAll('#board-library [data-lf-panel=created] .library-name')].map((n) => n.textContent)`;

const READ_TABS = `[...document.querySelectorAll('#board-library .lf-recent-tabs [role=tab]')].map((t) => {
  const b = t.getBoundingClientRect();
  return { label: t.textContent, x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
})`;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'library-created-live-'));
  let handle: ServerHandle | undefined;
  let browser: { proc: ChildProcess; profile: string } | undefined;
  try {
    step('build the client');
    // Its own outdir: two drivers sharing the package's dist delete each
    // other's bundles.
    const appDist = join(dir, 'app');
    const built = spawnSync(
      'bun',
      ['run', join(import.meta.dirname, '..', 'scripts', 'build.ts'), '--outdir', appDist],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`client build failed:\n${built.stderr}`);

    const dataDir = join(dir, 'data');
    handle = createServer({
      port: 0,
      dataDir,
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const person = signedInPerson(handle, dataDir, base, {
      email: 'alice@harborlight.example',
      name: 'Alice',
    });
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...person.headers },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return (await r.json()) as Record<string, unknown>;
    };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', leadAgentId: 'agent-harborlight' })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    await post(`/workspaces/${ws}/whiteboards`, { title: 'Saltmarsh sketch' });

    step('launch Chrome');
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `library-created-live-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const errors: string[] = [];
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = (p as { exceptionDetails?: { exception?: { description?: string } } })
        .exceptionDetails;
      errors.push(d?.exception?.description?.split('\n')[0] ?? 'exception');
    });
    const ev = <T>(expr: string) => cdp.evaluate(expr) as Promise<T>;
    // A reader with a name, so the page does not stop at "Who's reviewing?",
    // on a device that last left the Library on Recently Created.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('feedback-anon-id', 'alice-reader'); localStorage.setItem('feedback-user-name', 'Alice'); localStorage.setItem('cw-library-recent-tab', 'created'); } catch {}`,
    });
    const size = (width: number, height: number) =>
      cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width <= 500,
      });
    await size(1180, 820);
    const until = async <T>(what: string, read: () => Promise<T | null>, ms = 20_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const v = await read();
        if (v !== null) return v;
        await sleep(25);
      }
      const seen = await ev<string>(
        `location.pathname + ' | ' + document.body.innerText.slice(0, 400).replace(/\\s+/g, ' ')`,
      ).catch(() => 'unreadable');
      throw new Error(`never happened: ${what} — the page: ${seen}`);
    };

    step('open the Library');
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${base}/workspaces/${ws}/library` });
    await withTimeout(loaded, 30_000, 'the Library to load');
    const before = await until('Recently Created to list the first doc', async () => {
      const names = await ev<string[]>(READ_CREATED);
      return names.length > 0 ? names : null;
    });
    await ev(`window.__libraryLive = 'open-before-create'`);

    step('make a doc elsewhere');
    await post(`/workspaces/${ws}/whiteboards`, { title: 'Riverbend survey' });
    const answered = Date.now();
    let latencyMs: number | null = null;
    const after = await until('the new doc first in Recently Created', async () => {
      const names = await ev<string[]>(READ_CREATED);
      if (names[0] !== 'Riverbend survey') return null;
      latencyMs = Date.now() - answered;
      return names;
    }).catch(() => ev<string[]>(READ_CREATED));
    const samePage =
      (await ev<string | undefined>('window.__libraryLive')) === 'open-before-create';

    step('read the tab row at each size, once per chosen tab');
    const rows: TabRowReading[] = [];
    const shotDir = process.env.CW_SHOT_DIR;
    for (const [width, height] of [
      [1180, 820],
      [430, 932],
    ] as const) {
      await size(width, height);
      const byChoice: Record<string, TabBox[]> = {};
      for (const tab of ['viewed', 'modified', 'created']) {
        await ev(`document.querySelector('#board-library [data-lf-tab=${tab}]').click()`);
        await until(`the ${tab} tab chosen`, async () =>
          (await ev<boolean>(
            `document.querySelector('#board-library [data-lf-tab=${tab}]')?.getAttribute('aria-selected') === 'true'`,
          ))
            ? true
            : null,
        );
        byChoice[tab] = await ev<TabBox[]>(READ_TABS);
      }
      const overflow = await ev<boolean>(
        'document.documentElement.scrollWidth > window.innerWidth',
      );
      rows.push({ width, byChoice, overflow });
      if (shotDir) {
        await ev(`document.querySelector('#board-library [data-lf-tab=created]').click()`);
        const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as {
          data: string;
        };
        writeFileSync(join(shotDir, `library-tabs-${width}.png`), Buffer.from(png.data, 'base64'));
      }
    }
    const reading: LibraryCreatedLiveReading = {
      before,
      after,
      samePage,
      latencyMs,
      rows,
      errors,
    };
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
