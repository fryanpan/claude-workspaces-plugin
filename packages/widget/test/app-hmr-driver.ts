#!/usr/bin/env bun
/**
 * Real Vite behind `attach_app`, in a real browser, with no setting in the app
 * but the `--base` the board's prefix asks for and no reload code at all.
 *
 * The app is a page and a script that writes one word. The driver saves a new
 * word to the file on disk and reads the page, kills the dev server and starts
 * it on the same port, and saves again. A word reaching the frame after the
 * restart is the framework's own client having reconnected through the board.
 *
 * `APP_HMR_VITE_BIN` runs another Vite than the repo's: the client changed how
 * it waits for a restart at some point past 6.
 *
 * Spawned by `app-hmr.test.ts`, which reads the JSON it prints.
 *
 * audit: no-text — nothing here reads a source file, a bundle or a
 * stylesheet; every value it returns came from the running page.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer as listen } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  Cdp,
  type CdpResult,
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

export interface HmrReading {
  /** The word the frame showed after each step. */
  loaded: string;
  afterSave: string;
  afterRestart: string;
  afterSecondSave: string;
  /** What Vite's client said in the frame, in order. */
  viteLog: string[];
}

const PAGE =
  '<!doctype html><html><head><title>Harborlight events</title></head><body>' +
  '<h1 id="word">waiting</h1><script type="module" src="./main.js"></script></body></html>';
const script = (word: string) => `document.getElementById('word').textContent = '${word}';\n`;

function viteBin(): string {
  const named = process.env.APP_HMR_VITE_BIN;
  if (named) return named;
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
}

/** A port nothing holds, the one Vite is then told to take. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = listen();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

/** The two assets the frame needs, built from source into `dist`. */
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

async function poll<T>(what: string, read: () => Promise<T | null> | T | null): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = await Promise.resolve()
      .then(read)
      .catch(() => null);
    if (v !== null) return v;
    await sleep(100);
  }
  throw new Error(`never happened: ${what}`);
}

/** The app's frame: on the page's own target, or on its own when isolated. */
class AppFrame {
  private readonly sessions = new Set<string>();
  readonly log: string[] = [];

  constructor(private readonly cdp: Cdp) {}

  async start(): Promise<void> {
    const { cdp } = this;
    cdp.on('Target.attachedToTarget', (params) => {
      const sessionId = String(params.sessionId);
      this.sessions.add(sessionId);
      void cdp.send('Runtime.enable', {}, sessionId).catch(() => {});
    });
    cdp.on('Target.detachedFromTarget', (params) => this.sessions.delete(String(params.sessionId)));
    cdp.on('Runtime.consoleAPICalled', (params) => this.heard(params));
    await cdp.send('Runtime.enable');
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }

  private heard(params: CdpResult): void {
    const args = params.args as Array<{ value?: unknown }> | undefined;
    const text = String(args?.[0]?.value ?? '');
    if (text.startsWith('[vite]')) this.log.push(text);
  }

  async word(): Promise<string | null> {
    const expression = `document.getElementById('word')?.textContent ?? null`;
    for (const sessionId of this.sessions) {
      const r = await this.cdp
        .send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
        .catch(() => null);
      const value = (r?.result as { value?: unknown } | undefined)?.value;
      if (typeof value === 'string') return value;
    }
    const tree = (await this.cdp.send('Page.getFrameTree')) as {
      frameTree: { childFrames?: Array<{ frame: { id: string } }> };
    };
    const child = tree.frameTree.childFrames?.[0];
    if (!child) return null;
    const world = (await this.cdp.send('Page.createIsolatedWorld', {
      frameId: child.frame.id,
    })) as { executionContextId: number };
    const r = await this.cdp.send('Runtime.evaluate', {
      expression,
      contextId: world.executionContextId,
      returnByValue: true,
    });
    const value = (r.result as { value?: unknown } | undefined)?.value;
    return typeof value === 'string' ? value : null;
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'app-hmr-'));
  const site = join(dir, 'site');
  let handle: ServerHandle | undefined;
  let browser: { proc: ChildProcess; profile: string } | undefined;
  let vite: ChildProcess | undefined;
  try {
    const dist = join(dir, 'dist');
    buildAssets(dist);
    mkdirSync(site);
    writeFileSync(join(site, 'index.html'), PAGE);
    writeFileSync(join(site, 'main.js'), script('first'));

    // The frame-only hostname, as a board has it: a Vite app's scripts are ES
    // modules, which an opaque frame cannot load, because `Origin: null` gets
    // no CORS answer from a dev server.
    const boardPort = await freePort();
    handle = createServer({
      port: boardPort,
      dataDir: join(dir, 'data'),
      widgetDistDir: dist,
      requireSignInToWrite: false,
      frameOrigin: `http://frames.localhost:${boardPort}`,
      frameBoardHosts: [`127.0.0.1:${boardPort}`],
    });
    const base = `http://127.0.0.1:${boardPort}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as Record<string, unknown>;
    };
    const ws = (
      (await post('/workspaces', { name: 'Harborlight' })) as { workspace: { id: string } }
    ).workspace.id;
    const port = await freePort();
    const attached = (await post(`/workspaces/${ws}/apps`, {
      docId: 'harborlight-site',
      origin: `http://127.0.0.1:${port}`,
      servesPrefix: true,
    })) as { prefix: string };
    const { prefix } = attached;

    const bin = viteBin();
    const startVite = async (): Promise<ChildProcess> => {
      const proc = spawn(
        'node',
        [bin, '--base', prefix, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
        { cwd: site, stdio: 'ignore' },
      );
      const page = `http://127.0.0.1:${port}${prefix}`;
      await poll('vite to answer', async () => ((await fetch(page)).ok ? true : null));
      return proc;
    };
    vite = await startVite();

    const b = await launchChrome(
      resolveChromeBin(undefined),
      (profile) => chromeLaunchArgs({ width: 1180, height: 820 }, profile),
      STARTUP_TIMEOUT_MS,
      `app-hmr-${process.pid}`,
      (started) => {
        browser = started;
      },
    );
    const cdp = await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS));
    await cdp.send('Page.enable');
    const frame = new AppFrame(cdp);
    await frame.start();
    await cdp.send('Page.navigate', { url: `${base}${prefix}` });

    const shows = (word: string) => async () => ((await frame.word()) === word ? word : null);
    const connected = () => frame.log.filter((l) => l === '[vite] connected.').length;

    const loaded = await poll('the frame to run the script', shows('first'));
    await poll('the client to connect', () => (connected() >= 1 ? true : null));
    writeFileSync(join(site, 'main.js'), script('second'));
    const afterSave = await poll('a save to reach the page', shows('second'));
    // A full reload starts a new client: kill the server after it is up.
    await poll('the reloaded client to connect', () => (connected() >= 2 ? true : null));

    const before = connected();
    vite.kill('SIGKILL');
    await poll('the client to see it go', () =>
      frame.log.some((l) => l.includes('server connection lost')) ? true : null,
    );
    writeFileSync(join(site, 'main.js'), script('third'));
    vite = await startVite();
    const afterRestart = await poll('the page to come back after a restart', shows('third'));
    await poll('the client to reconnect', () => (connected() > before ? true : null));
    writeFileSync(join(site, 'main.js'), script('fourth'));
    const afterSecondSave = await poll('a save after the restart', shows('fourth'));

    const reading: HmrReading = {
      loaded,
      afterSave,
      afterRestart,
      afterSecondSave,
      viteLog: frame.log,
    };
    cdp.close();
    process.stdout.write(`\n${JSON.stringify(reading)}\n`);
  } finally {
    vite?.kill('SIGKILL');
    if (browser) await stopBrowser(browser.proc, browser.profile);
    await handle?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
