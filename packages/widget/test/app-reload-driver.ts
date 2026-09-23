#!/usr/bin/env bun
/**
 * An attached dev server's reload stream, end to end: a site's dev server
 * serving a page from a file and announcing a reload on its event stream
 * whenever that file changes, attached to a real board server, opened
 * through the board's app address in headless Chromium.
 *
 * The page lives in the sandboxed frame and listens on the relative
 * `__reload`, the way a static site's dev script does; the bridge relays the
 * stream through the host page, and the board proxies it to the dev server.
 * The driver changes the file and reads the frame's text until the new
 * version shows, or five seconds pass.
 *
 * Spawned by `app-reload.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns came from the running page.
 */
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Cdp,
  launchChrome,
  pageSocketUrl,
  sleep,
  stopBrowser,
} from '../../../scripts/headless-chrome.ts';
import {
  STARTUP_TIMEOUT_MS,
  chromeLaunchArgs,
  resolveChromeBin,
} from '../../../scripts/ui-shot-lib.ts';
import { type ServerHandle, createServer } from '../../server/src/server.ts';

/** How long a change may take to show. The task's criterion. */
export const BUDGET_MS = 5000;

export interface Reading {
  /** The frame's text before the change. */
  before: string | null;
  /** The frame's text when the driver stopped reading. */
  after: string | null;
  /** Whether the new version showed inside the budget. */
  arrived: boolean;
  /** From the file write to the new text read in the frame. */
  latencyMs: number;
  /** Reload streams the dev server had open when the file changed. */
  streamsAtChange: number;
}

const page = (version: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Harborlight events</title></head>
<body><p id="v">${version}</p>
<script>
  new EventSource('__reload').addEventListener('reload', () => location.reload());
</script></body></html>`;

/** A site's dev server: one page from disk, and a reload per file change. */
function devServer(file: string) {
  const enc = new TextEncoder();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const watcher = watch(file, () => {
    for (const c of streams) {
      try {
        c.enqueue(enc.encode('event: reload\ndata: 1\n\n'));
      } catch {
        streams.delete(c);
      }
    }
  });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/') {
        return new Response(readFileSync(file, 'utf8'), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      if (path === '/__reload') {
        let mine: ReadableStreamDefaultController<Uint8Array> | undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              mine = c;
              streams.add(c);
              c.enqueue(enc.encode(': open\n\n'));
            },
            cancel() {
              if (mine) streams.delete(mine);
            },
          }),
          { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } },
        );
      }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    open: () => streams.size,
    async stop() {
      watcher.close();
      await server.stop(true);
    },
  };
}

/** The two sandbox assets, built from source into `dist`. */
function buildAssets(dist: string): void {
  for (const name of ['mock-bridge', 'mock-host']) {
    const built = spawnSync(
      'bun',
      [
        'build',
        join(import.meta.dirname, '../src', `${name}.ts`),
        '--target=browser',
        '--format=iife',
        `--outfile=${join(dist, `${name}.js`)}`,
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );
    if (built.status !== 0) throw new Error(`bun build ${name} failed: ${built.stderr}`);
  }
}

/**
 * The sandboxed frame runs out of process, so it is its own CDP target:
 * attach to every child frame as it appears and keep its session.
 */
async function attachFrames(cdp: Cdp): Promise<string[]> {
  const sessions: string[] = [];
  cdp.on('Target.attachedToTarget', (p) => {
    const sessionId = p.sessionId as string;
    if ((p.targetInfo as { type?: string } | undefined)?.type === 'iframe')
      sessions.push(sessionId);
    void cdp
      .send('Runtime.enable', {}, sessionId)
      .then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId))
      .catch(() => {});
  });
  cdp.on('Target.detachedFromTarget', (p) => {
    const i = sessions.indexOf(p.sessionId as string);
    if (i >= 0) sessions.splice(i, 1);
  });
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  return sessions;
}

/** The app frame's `#v` text, or null while no frame holds one. */
async function frameText(cdp: Cdp, sessions: string[]): Promise<string | null> {
  for (const sessionId of [...sessions]) {
    const r = (await cdp
      .send(
        'Runtime.evaluate',
        { expression: "document.getElementById('v')?.textContent ?? null", returnByValue: true },
        sessionId,
      )
      .catch(() => null)) as { result?: { value?: string | null } } | null;
    const v = r?.result?.value;
    if (typeof v === 'string') return v;
  }
  return null;
}

async function poll<T>(what: string, read: () => Promise<T | null>, ms: number): Promise<T> {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    const v = await read();
    if (v !== null) return v;
    await sleep(25);
  }
  throw new Error(`never happened: ${what}`);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'app-reload-'));
  let handle: ServerHandle | undefined;
  let dev: ReturnType<typeof devServer> | undefined;
  let browser: { proc: ChildProcess; profile: string } | undefined;
  try {
    const dist = join(dir, 'dist');
    buildAssets(dist);
    const site = join(dir, 'site');
    mkdirSync(site);
    const file = join(site, 'index.html');
    writeFileSync(file, page('one'));
    dev = devServer(file);
    handle = createServer({
      port: 0,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      requireSignInToWrite: false,
    });
    const base = `http://127.0.0.1:${handle.port}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const agent = { id: 'agent-harborlight', name: 'Harborlight site', kind: 'agent' };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight', author: agent })) as {
        workspace: { id: string };
      }
    ).workspace.id;
    const { prefix } = (await post(`/workspaces/${ws}/apps`, {
      docId: 'harborlight-site',
      origin: dev.origin,
    })) as { prefix: string };

    const bin = resolveChromeBin(undefined);
    const b = await launchChrome(
      bin,
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `app-reload-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const sessions = await attachFrames(cdp);
    await cdp.send('Page.navigate', { url: `${base}${prefix}` });

    const before = await poll(
      'the app showed in its frame',
      () => frameText(cdp, sessions),
      30_000,
    );
    const d = dev;
    await poll(
      'the page opened its reload stream',
      async () => (d.open() > 0 ? true : null),
      30_000,
    );
    const streamsAtChange = d.open();

    const t0 = performance.now();
    writeFileSync(file, page('two'));
    let after: string | null = before;
    let arrived = false;
    while (performance.now() - t0 < BUDGET_MS) {
      after = await frameText(cdp, sessions);
      if (after === 'two') {
        arrived = true;
        break;
      }
      await sleep(25);
    }
    const latencyMs = Math.round(performance.now() - t0);
    cdp.close();
    const reading: Reading = { before, after, arrived, latencyMs, streamsAtChange };
    // Last line of stdout: the server logs its own lines above it.
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    await dev?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
