#!/usr/bin/env bun
/**
 * `bun run check:client-boot` — build the real client, serve it, open a doc
 * page in headless Chrome, and fail if the editor does not mount or anything
 * throws.
 *
 * WHY THIS EXISTS. PR 817 was merged and deployed with sixteen green `verify`
 * members and eight green CI checks. Every doc page in every workspace in
 * production then rendered its chrome and no body, because the BUNDLED client
 * threw `ReferenceError: kO8 is not defined` while tiptap was constructing the
 * editor. Nothing in CI had ever loaded the bundle. vitest runs unbundled ESM
 * and the server suite runs no browser at all, so the one artifact a user
 * actually receives was the one artifact nothing tested.
 *
 * `check:import-cycles` removes the specific cause. This removes the CLASS: a
 * bundler-ordering fault, a minifier fault, a bad chunk split, a missing
 * asset, a broken shell — anything that is true of the built client and false
 * of the source — has to get past a real browser loading a real page.
 *
 * WHAT IT ASSERTS, and both halves matter:
 *
 *   1. `#editor > .ProseMirror` exists. That element is created by tiptap
 *      itself, at the end of the construction that PR 817's bundle died in the
 *      middle of, so its presence is the narrowest available proof that the
 *      editor got built. A shell-only page — exactly what production served
 *      — renders `#editor` and never fills it.
 *   2. Nothing threw. `Runtime.exceptionThrown` and error-level
 *      `Log.entryAdded` are collected for the whole run. This is the half that
 *      would have caught PR 817 even if the failure had been silent about the
 *      DOM, and it is why the check listens from before the navigation rather
 *      than asking afterwards.
 *
 * The wait is a poll, never a sleep: the mount deadline is a ceiling, and a
 * page that mounts in 400ms costs 400ms.
 *
 * WHAT IT DOES NOT COVER. One page, one doc, desktop width, no interaction.
 * It is a boot check, not a UI suite — `bun run ui:shot` and the client tests
 * are the other tools. Widening it is fine; letting it get slow enough that
 * somebody takes it out of `verify` is not.
 *
 * LOAD AND MOUNT ARE TIMED SEPARATELY. The mount ceiling starts at the load
 * event, because what happens before it is the transport delivering the
 * bundle and what happens after it is the bundle building the editor — and
 * only the second is what this check is for. They shared one ten-second clock
 * until 2026-09-11, when a Mac whose loopback ran at ~135 KB/s took 15s to
 * deliver `app.js` and failed the check for every builder on a page that
 * mounted 41ms after it loaded. A slow load is now measured against a control
 * and named (client-boot-transport.ts), not reported as a broken page.
 *
 *   bun run check:client-boot [--keep] [--port N] [--timeout MS]
 *                             [--load-timeout MS] [--shot out.png]
 *
 *   --keep          leave the data dir and the client release root behind
 *   --port          port to bind (default 0: the OS picks a free one). A
 *                   reserved fleet port is refused.
 *   --timeout       ceiling for the editor to mount after the load event, in
 *                   ms (default 10000)
 *   --load-timeout  ceiling for the load event itself, in ms (default 90000)
 *   --shot          write a PNG of the loaded page, for looking at a failure
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareClientRelease } from '../packages/server/src/client-release.ts';
import { reservedPortOwner } from '../packages/server/src/reserved-ports.ts';
import {
  RESOURCE_TIMING_PROBE,
  type Transfer,
  describeTransport,
} from './client-boot-transport.ts';
import {
  type Browser,
  Cdp,
  killAndRemove,
  launchChrome,
  pageSocketUrl,
  sleep,
  withTimeout,
} from './headless-chrome.ts';
import { chromeLaunchArgs, resolveChromeBin, resolveRunId } from './ui-shot-lib.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (msg: string) => process.stderr.write(`client-boot: ${msg}\n`);

/** The viewport the repo verifies at — iPad landscape, the primary device. */
const VIEWPORT = { width: 1180, height: 820 } as const;

/**
 * The element tiptap mounts, as a child of the shell's editor host.
 *
 * `#editor >`, not a bare `.ProseMirror`: the page has other ProseMirror
 * instances (the comment composer, the redline view), and a check that
 * accepted any of them would pass on the very page that shipped — the shell
 * came up fine, it was the document editor that never built.
 */
const EDITOR_SELECTOR = '#editor > .ProseMirror';

/** `NAME_KEY` in packages/core/src/identity.ts — the stored display name that
 *  makes this browser a returning visitor rather than a first arrival. */
const IDENTITY_NAME_KEY = 'feedback-user-name';

/** A load slower than this gets its transport measured and reported, even
 *  when the check passes — so the machine's state is named on the day it
 *  starts, not on the day it crosses the ceiling. */
const SLOW_LOAD_MS = 5_000;

/**
 * Ports this check never binds, even when asked: the server's reserved list,
 * plus two it does not carry. 7903 is another fleet service; 8800 was this
 * check's own default, which meant every `verify` on the machine bound the
 * same fixed port that other tooling also reaches for.
 */
const CHECK_AVOIDS: Readonly<Record<number, string>> = {
  7903: 'a fleet service outside the server list',
  8800: "this check's old fixed default",
};

interface Options {
  port: number;
  timeoutMs: number;
  loadTimeoutMs: number;
  keep: boolean;
  shot?: string;
}

export function parseArgs(argv: readonly string[]): Options {
  const read = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (name: string, fallback: number, min = 1): number => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) {
      throw new Error(`--${name}: expected an integer of at least ${min}`);
    }
    return n;
  };
  // 0, so the OS picks: a fixed default is a port every run on the machine
  // competes for, and bin.ts announces the one it actually bound.
  const port = num('port', 0, 0);
  const owner = reservedPortOwner(port) ?? CHECK_AVOIDS[port];
  if (owner)
    throw new Error(`--port ${port} is reserved (${owner}); omit --port to let the OS pick`);
  return {
    port,
    timeoutMs: num('timeout', 10_000),
    loadTimeoutMs: num('load-timeout', 90_000),
    keep: argv.includes('--keep'),
    ...(read('shot') !== undefined ? { shot: read('shot') as string } : {}),
  };
}

/** Run a build, inheriting its output — a failed bundle must be readable. */
function build(pkg: string): void {
  const r = spawnSync('bun', ['run', join(REPO_ROOT, 'packages', pkg, 'scripts', 'build.ts')], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (r.status !== 0) throw new Error(`${pkg} build failed with status ${r.status}`);
}

/**
 * The port the server actually bound.
 *
 * It is not necessarily the one we asked for: `bin.ts` walks up to twenty
 * ports when the first is busy, which is what makes this check safe to run
 * while other things on the machine hold ports. So the announcement is read,
 * never assumed — a check that hard-coded its port would talk to whatever
 * else was listening and report on the wrong server.
 */
export function listeningPort(line: string): number | null {
  // Today the line is `[feedback] listening on :8800`. The pattern also
  // accepts a full URL after "listening on", so a future line that names the
  // host is read rather than silently ignored — an unparsed announcement
  // would time this check out with "server never announced a port", which
  // reads like a boot failure and is not one.
  const m = /listening on .*:(\d+)\s*$/.exec(line);
  return m?.[1] ? Number(m[1]) : null;
}

async function waitForServer(base: string, proc: ChildProcess, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited with ${proc.exitCode} during boot`);
    try {
      const r = await fetch(base, { redirect: 'manual' });
      if (r.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }
  throw new Error(`server never answered on ${base}`);
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`POST ${url} → ${r.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/** A board and a file-backed markdown doc, and the page path that opens it. */
async function seedDoc(base: string, dataDir: string): Promise<string> {
  const board = (await postJson(`${base}/workspaces`, {
    name: 'client boot check',
    author: { id: 'agent:client-boot-check', name: 'client-boot-check', kind: 'agent' },
  })) as { workspace?: { id?: string } };
  const boardId = board.workspace?.id;
  if (!boardId) throw new Error(`no workspace id in the create response: ${JSON.stringify(board)}`);

  const path = join(dataDir, 'client-boot-check.md');
  writeFileSync(
    path,
    '# Client boot check\n\nA paragraph, a list and a heading, so the editor has\n' +
      'more than one node kind to build.\n\n- one\n- two\n\n## Second heading\n\nEnd.\n',
  );
  const doc = (await postJson(`${base}/workspaces/${boardId}/docs`, {
    docId: 'client-boot-check',
    type: 'markdown',
    title: 'Client boot check',
    sourceUrl: path,
  })) as { docId?: string; meta?: { reviewUrl?: string } };

  // The review URL is minted server-side by the one function that builds a doc
  // address, so taking it back beats reassembling the path here — this check
  // then follows a route change instead of breaking on one.
  //
  // Only its PATH, though. The server mints an absolute URL against whatever
  // public base it discovered — on this fleet that is the tailnet hostname —
  // and this check must talk to the loopback server it just started, not to
  // whatever answers on the tailnet. Concatenating the two produced a URL
  // Chrome refused outright, which was at least loud; a machine whose tailnet
  // name resolved would have quietly checked the WRONG server.
  const raw = doc.meta?.reviewUrl;
  if (raw) return raw.startsWith('/') ? raw : new URL(raw).pathname;
  if (doc.docId) return `/workspaces/${boardId}/docs/${doc.docId}`;
  throw new Error(`no reviewUrl or docId in the doc response: ${JSON.stringify(doc)}`);
}

/** A page-side failure, in the form the summary prints. */
interface PageError {
  kind: 'exception' | 'console';
  text: string;
}

export function exceptionText(params: Record<string, unknown>): string {
  const d = (params.exceptionDetails ?? {}) as {
    text?: string;
    exception?: { description?: string };
    url?: string;
    lineNumber?: number;
  };
  const where = d.url ? ` (${d.url}:${d.lineNumber ?? '?'})` : '';
  return `${d.exception?.description ?? d.text ?? 'unknown exception'}${where}`;
}

/**
 * Load the page and report what happened.
 *
 * The listeners are attached BEFORE the navigation, because the failure this
 * exists for happens during module evaluation — asking the page afterwards
 * would find a console that had already scrolled past it, on a page that no
 * longer has the object that threw.
 */
interface PageResult {
  errors: PageError[];
  mounted: boolean;
  /** From the load event to the mount (or to the mount deadline). */
  mountMs: number;
  /** From navigation to the load event; null when it never came. */
  loadMs: number | null;
  transfers: Transfer[];
  /** Scripts the page names that had not finished arriving when it was read. */
  pendingScripts: string[];
}

async function loadDocPage(
  cdp: Cdp,
  url: string,
  o: Pick<Options, 'timeoutMs' | 'loadTimeoutMs' | 'shot'>,
): Promise<PageResult> {
  const errors: PageError[] = [];
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  // A throwaway Chrome profile is a FIRST ARRIVAL, and a first arrival gets
  // the "Who's reviewing?" modal — under which the editor does not build at
  // all. So the first run of this check went red on a page that was perfectly
  // healthy, which is worth keeping in mind when reading a failure: an
  // un-mounted editor means "this page did not reach an editor", and the
  // modal was one way to get there.
  //
  // `?as=` does not help: it skips the prompt only for a name in the known-
  // users table. Seeding the stored name at document start is the posture of
  // every returning visitor, and it is set BEFORE the page's own scripts run,
  // so the app never sees the un-named state.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem(${JSON.stringify(IDENTITY_NAME_KEY)}, 'client-boot-check'); } catch {}`,
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    errors.push({ kind: 'exception', text: exceptionText(p) });
  });
  cdp.on('Log.entryAdded', (p) => {
    const e = (p.entry ?? {}) as { level?: string; text?: string; url?: string };
    if (e.level !== 'error') return;
    // Chrome asks for /favicon.ico on its own, for every page, and this app
    // ships an SVG icon instead — so that 404 is the browser's request
    // failing, not the page's. It is the ONLY exclusion, and it is by exact
    // path: a 404 on app.js or a stylesheet is a real finding and stays one.
    // (The mount assertion would catch a missing app.js anyway, which is why
    // this narrow hole costs nothing.)
    if (e.url?.endsWith('/favicon.ico')) return;
    errors.push({ kind: 'console', text: `${e.text ?? ''}${e.url ? ` (${e.url})` : ''}`.trim() });
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    ...VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const started = Date.now();
  const loaded = cdp.once('Page.loadEventFired');
  const nav = await cdp.send('Page.navigate', { url });
  if (nav.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
  let loadMs: number | null = null;
  try {
    await withTimeout(loaded, o.loadTimeoutMs, 'page load');
    loadMs = Date.now() - started;
  } catch {
    // Reported by the caller with the transport measured, not thrown as a
    // bare timeout — see the module comment.
  }

  // Poll, never sleep: a mount that takes 300ms costs 300ms, and the deadline
  // is only ever paid by a page that is actually broken. The clock starts at
  // the load event, so it measures the bundle and not the wire.
  const probe = `!!document.querySelector(${JSON.stringify(EDITOR_SELECTOR)})`;
  let mounted = false;
  const mountFrom = Date.now();
  const deadline = mountFrom + o.timeoutMs;
  while (loadMs !== null && Date.now() < deadline) {
    if (await cdp.evaluate(probe)) {
      mounted = true;
      break;
    }
    await sleep(100);
  }
  const mountMs = Date.now() - mountFrom;
  const { done, scripts } = JSON.parse(String(await cdp.evaluate(RESOURCE_TIMING_PROBE))) as {
    done: Transfer[];
    scripts: string[];
  };
  const arrived = new Set(done.map((t) => t.url));
  const pendingScripts = scripts.filter((src) => !arrived.has(src));
  const shot = o.shot;

  if (shot) {
    const png = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    mkdirSync(dirname(shot), { recursive: true });
    writeFileSync(shot, Buffer.from(png.data, 'base64'));
  }
  // A late exception — one thrown after the editor mounted, during hydration
  // or a first render — is still a broken page, so give the listeners a beat.
  await sleep(250);
  return { errors, mounted, mountMs, loadMs, transfers: done, pendingScripts };
}

async function run(o: Options): Promise<number> {
  const chrome = resolveChromeBin(undefined);
  build('widget');
  build('workspaces-app');

  const dataDir = mkdtempSync(join(tmpdir(), 'cw-client-boot-data-'));
  const releaseRoot = mkdtempSync(join(tmpdir(), 'cw-client-boot-release-'));
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  let cdp: Cdp | undefined;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      cdp?.close();
    } catch {}
    if (browser) killAndRemove(browser.proc, browser.profile);
    if (server && server.exitCode === null) server.kill('SIGKILL');
    if (o.keep) {
      log(`kept ${dataDir} and ${releaseRoot}`);
      return;
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(releaseRoot, { recursive: true, force: true });
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('exit', cleanup);

  try {
    // The SAME publish prod performs, into a throwaway root. Serving
    // `packages/workspaces-app/dist` directly would test bytes nobody
    // receives: publishClientRelease is what copies, hashes and freezes them,
    // and a fault it introduced would be invisible to a check that skipped it.
    const prepared = prepareClientRelease({
      root: releaseRoot,
      sources: {
        widget: join(REPO_ROOT, 'packages', 'widget', 'dist'),
        markdownApp: join(REPO_ROOT, 'packages', 'workspaces-app', 'dist'),
      },
    });
    if (prepared.stale || !prepared.markdownApp) {
      throw new Error(`client release was not published: ${prepared.error ?? 'unknown'}`);
    }

    const args = [
      'run',
      join(REPO_ROOT, 'packages', 'server', 'src', 'bin.ts'),
      '--port',
      String(o.port),
      '--host',
      '127.0.0.1',
      '--data-dir',
      dataDir,
      '--workspaces-app-dist',
      prepared.markdownApp,
      ...(prepared.widget ? ['--widget-dist', prepared.widget] : []),
    ];
    // Sentry is unset rather than inherited: a runner that has a DSN would
    // otherwise inject the browser SDK into the shell, which changes what
    // this check is loading and posts this check's own errors to prod.
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const k of ['CW_SENTRY_DSN', 'CW_SENTRY_SERVER_DSN', 'CW_PUBLIC_BASE_URL']) delete env[k];
    env.CW_REQUIRE_SIGNIN_TO_WRITE = '0';

    server = spawn('bun', args, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
    let bound: number | null = null;
    let out = '';
    server.stdout?.on('data', (d) => {
      out += String(d);
      for (const line of out.split('\n')) bound ??= listeningPort(line);
    });

    const bootDeadline = Date.now() + 60_000;
    while (bound === null && Date.now() < bootDeadline) {
      if (server.exitCode !== null) throw new Error(`server exited with ${server.exitCode}`);
      await sleep(100);
    }
    if (bound === null) throw new Error(`server never announced a port:\n${out}`);
    const base = `http://127.0.0.1:${bound}`;
    await waitForServer(base, server, bootDeadline);
    log(`server on ${base}, data dir ${dataDir}`);

    const docPath = await seedDoc(base, dataDir);
    const pageUrl = `${base}${docPath}`;
    log(`opening ${pageUrl}`);

    const runId = resolveRunId();
    browser = await launchChrome(
      chrome,
      (profile) => chromeLaunchArgs(VIEWPORT, profile),
      30_000,
      runId,
      (b) => {
        browser = b;
      },
    );
    cdp = await Cdp.connect(await pageSocketUrl(browser.port, 30_000));
    const page = await loadDocPage(cdp, pageUrl, o);
    const { errors, mounted, mountMs, loadMs } = page;
    const transport =
      loadMs === null || loadMs > SLOW_LOAD_MS
        ? await describeTransport(page.transfers, page.pendingScripts, o.loadTimeoutMs)
        : [];

    if (mounted && errors.length === 0) {
      console.log(
        `✅ the built client booted: ${EDITOR_SELECTOR} mounted ${mountMs}ms after load, nothing threw.`,
      );
      if (transport.length > 0) {
        console.log(`   The load itself took ${loadMs}ms, which is the transport:`);
        for (const line of transport) console.log(line);
      }
      return 0;
    }
    if (loadMs === null) {
      console.error(
        `❌ the page never fired its load event within ${o.loadTimeoutMs}ms, so the editor\n` +
          '   was never given the chance to mount. What the wire was doing:',
      );
      for (const line of transport) console.error(line);
    } else if (!mounted) {
      console.error(
        `❌ ${EDITOR_SELECTOR} never mounted within ${o.timeoutMs}ms of the load event — the page rendered its\n` +
          '   chrome and no editor, which is exactly what production served after PR 817.',
      );
    }
    for (const e of errors) console.error(`❌ page ${e.kind}: ${e.text}`);
    if (loadMs !== null && transport.length > 0) {
      // Not the cause — the mount clock starts at the load event — but a
      // reader of this failure should not have to rediscover the wire.
      console.error(`   The load before it took ${loadMs}ms, which is the transport:`);
      for (const line of transport) console.error(line);
    }
    if (loadMs === null) {
      // Nothing about the bundle is known yet, so the bundle's usual suspects
      // are not named: the wire above is the whole of what was measured.
      console.error(`\n   ${pageUrl}\n   Raise --load-timeout if this machine is simply slow.`);
      return 1;
    }
    console.error(
      `\n   ${pageUrl}\n` +
        '   Re-run with --keep --shot /tmp/boot.png to look at it. The two causes\n' +
        '   seen so far are a dangling namespace getter (a `ns.NAME` read the\n' +
        '   tree-shaker could not see, so the module was dropped) and an import\n' +
        '   cycle — `bun run check:import-cycles` answers the second.',
    );
    return 1;
  } finally {
    cleanup();
  }
}

if (import.meta.main) {
  run(parseArgs(process.argv.slice(2))).then(
    (code) => process.exit(code),
    (err) => {
      log(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(1);
    },
  );
}
