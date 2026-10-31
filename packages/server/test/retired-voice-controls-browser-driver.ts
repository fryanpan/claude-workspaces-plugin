#!/usr/bin/env bun
/**
 * Opens the board and a markdown doc in headless Chromium against a real
 * server, at 1180x820 and at 430x932, and reports which voice controls each
 * page shows. Bryan, 2026-10-30, asked for the board's speaker button beside
 * the agent button and the doc's Talk mode, Record Audio and voice-feedback
 * mic to go; this reads what the built pages actually draw.
 *
 * Each page also reports a control it still has — the agent button on the
 * board, the top bar's buttons on the doc — so an empty reading of the
 * retired controls means they are gone, not that the page never rendered.
 *
 * Spawned by `packages/workspaces-app/test/retired-voice-controls-browser.test.ts`,
 * which reads the JSON this prints on its last line.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns was read off the running page.
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
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

const LEAD = { agentId: 'riverbend-lead', agentName: 'Riverbend Lead' };

/** What one page showed at one size. */
export interface PageReading {
  /** The control the page must still have — the positive control. */
  kept: boolean;
  /** Every retired control the page drew, by selector. Empty is the pass. */
  retired: string[];
  /** Visible buttons whose name reads as one of the retired controls. */
  namedLikeRetired: string[];
}

export interface RetiredVoiceReading {
  board: Record<'ipad' | 'phone', PageReading>;
  doc: Record<'ipad' | 'phone', PageReading>;
  errors: string[];
}

const SIZES = {
  ipad: { width: 1180, height: 820 },
  phone: { width: 430, height: 932 },
} as const;

/** The board's retired speaker button and its readout. */
const BOARD_RETIRED = ['#board-mic', '#board-voice', '.board-nav-dock .voice-mic'];
/** The doc bar's Record Audio, its options chevron, the voice mic and Talk. */
const DOC_RETIRED = [
  '.meeting-record',
  '.meeting-record-options',
  '.doc-voice-mic',
  '.doc-interview-btn',
];
const RETIRED_NAMES = /^(talk\b|record audio|tap to talk|talk to comment)/i;

const step = (what: string): void => {
  process.stderr.write(`[retired-voice-controls-browser-driver] ${what}\n`);
};

/**
 * A control the page still has, drawn in the same mount as the retired ones:
 * the agent button on the board, the Review float on the doc. Until it is
 * there a reading proves nothing. The doc's top bar is static markup, and the
 * editor paints the doc's text before the mount has added the rest, so
 * neither of those would do.
 */
interface Kept {
  selector: string;
  /** Whether it must be drawn, or only mounted. The board's agent button
   *  sits in the static shell, hidden until the board boots, so it must be
   *  drawn; the doc's Review float is mounted hidden on a doc with nothing
   *  to review, so being in the page is the signal. */
  drawn: boolean;
}

/** A page-side read: the kept control, the retired selectors, and the names. */
function readExpr(kept: Kept, retired: readonly string[]): string {
  return `(() => {
    const vis = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
    };
    const name = (e) => (e.getAttribute('aria-label') || e.title || e.textContent || '').trim();
    return {
      kept: [...document.querySelectorAll(${JSON.stringify(kept.selector)})].some(
        (e) => ${kept.drawn} === false || vis(e),
      ),
      retired: ${JSON.stringify(retired)}.filter((sel) => document.querySelector(sel) !== null),
      namedLikeRetired: [...document.querySelectorAll('button')]
        .filter(vis)
        .map(name)
        .filter((n) => ${RETIRED_NAMES}.test(n)),
    };
  })()`;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'retired-voice-browser-'));
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

    // Writes open to an unsigned browser, as on the owner's own machine: the
    // doc draws its writing controls only for a page that may write.
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      markdownAppDistDir: appDist,
      requireSignInToWrite: false,
    });
    const local = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
      const r = await fetch(`${local}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return (await r.json()) as Record<string, unknown>;
    };
    const ws = (
      (await post('/workspaces', { name: 'Riverbend', leadAgentId: LEAD.agentId })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    await post(`/workspaces/${ws}/agents`, { ...LEAD, runtime: 'claude-code-local' });
    const md = join(dir, 'plan.md');
    writeFileSync(md, '# Riverbend plan\n\nA paragraph about Harborlight.\n\n## Next\n\nMore.\n');
    const doc = (await post(`/workspaces/${ws}/docs`, {
      docId: 'plan',
      type: 'markdown',
      sourceUrl: md,
      owner: dir,
    })) as { id?: string; docId?: string; doc?: { id: string } };
    const docId = doc.doc?.id ?? doc.id ?? doc.docId ?? 'plan';

    step('launch Chrome');
    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs(SIZES.ipad, profile),
      STARTUP_TIMEOUT_MS,
      `retired-voice-browser-${process.pid}`,
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

    // A first visit asks for a name before the doc mounts its chrome.
    const answerIdentity = `(() => {
      const inp = document.querySelector('.identity-prompt input, [id^=identity] input, #identity-name');
      if (!inp) return false;
      inp.value = 'Alice';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const go = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Continue');
      if (go) go.click();
      return true;
    })()`;

    const read = async (
      url: string,
      size: keyof typeof SIZES,
      kept: Kept,
      retired: readonly string[],
    ): Promise<PageReading> => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        ...SIZES[size],
        deviceScaleFactor: 1,
        mobile: size === 'phone',
      });
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await withTimeout(loaded, 30_000, `${url} to load`);
      const expr = readExpr(kept, retired);
      // Wait for the kept control: the page has mounted its chrome by then.
      // The name prompt is answered on every poll, not once, because it can
      // arrive after the load event and the page waits on it.
      await waitFor(
        async () => {
          await ev(answerIdentity).catch(() => false);
          return (await ev<PageReading>(expr).catch(() => null))?.kept === true;
        },
        { timeout: 20_000, describe: `${kept.selector} on ${url} at ${size}` },
      ).catch(() => undefined);
      return ev<PageReading>(expr);
    };

    const boardUrl = `${local}/workspaces/${ws}`;
    const docUrl = `${local}/workspaces/${ws}/docs/${encodeURIComponent(docId)}`;
    const reading: RetiredVoiceReading = { board: {}, doc: {}, errors } as RetiredVoiceReading;
    for (const size of ['ipad', 'phone'] as const) {
      step(`board at ${size}`);
      reading.board[size] = await read(
        boardUrl,
        size,
        { selector: '#board-lead-chat', drawn: true },
        BOARD_RETIRED,
      );
      step(`doc at ${size}`);
      reading.doc[size] = await read(
        docUrl,
        size,
        { selector: '.review-float', drawn: false },
        DOC_RETIRED,
      );
    }
    cdp.close();
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
