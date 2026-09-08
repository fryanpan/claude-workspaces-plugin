#!/usr/bin/env bun
/**
 * Driving a throwaway headless Chrome over CDP: the browser, the socket, and
 * the cleanup that is the reason this is a module rather than a snippet.
 *
 * It was the private half of `scripts/ui-shot.ts` until
 * `scripts/client-boot-check.ts` needed the same browser. A second copy of a
 * CDP client is not the cost — the cost is a second copy of the cleanup,
 * which is where all the sharp edges are, and which was learned from profiles
 * found stale on a shared machine:
 *
 *   - the profile and the process are registered the INSTANT they exist, not
 *     when the launch finishes. A signal arriving while Chrome was starting
 *     used to find nothing to clean and left a full profile plus a headless
 *     Chrome running forever (reproduced 6 times out of 6).
 *   - the removal WAITS for Chrome to actually die. `kill()` returns long
 *     before the process does, and a starting Chrome rebuilds every file it
 *     owns moments after `rmSync` takes the directory away.
 *   - the teardown is synchronous, because it also runs from the `exit`
 *     handler, and in that handler an awaited cleanup never happens at all.
 *
 * Never point any of this at a browser a person is using: `--headless=new`
 * with a throwaway `--user-data-dir` under the OS temp dir is a separate
 * instance with no shared profile, no shared window and no visible tab.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profilePrefix } from './ui-shot-lib.ts';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(() => r(), ms));

export type CdpResult = Record<string, unknown>;

/** Minimal CDP client over the page target's WebSocket. */
export class Cdp {
  private id = 0;
  private pending = new Map<
    number,
    { resolve: (v: CdpResult) => void; reject: (e: Error) => void }
  >();
  private listeners = new Map<string, Array<(params: CdpResult) => void>>();
  private constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (typeof m.id === 'number') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${m.error.message} (code ${m.error.code})`));
        else p.resolve(m.result);
      } else if (m.method) {
        for (const fn of this.listeners.get(m.method) ?? []) fn(m.params);
      }
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`could not open CDP socket ${url}`));
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpResult> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  once(method: string): Promise<CdpResult> {
    return new Promise((resolve) => {
      const list = this.listeners.get(method) ?? [];
      list.push(resolve);
      this.listeners.set(method, list);
    });
  }

  /** Subscribe for every occurrence. Used to COLLECT — page exceptions, error
   *  console entries — where `once` would see the first and miss the rest. */
  on(method: string, fn: (params: CdpResult) => void): void {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
  }

  /** Evaluate in the page; throws on a page-side exception. */
  async evaluate(expression: string): Promise<unknown> {
    const r = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page threw: ${d.exception?.description ?? d.text}`);
    }
    return r.result?.value;
  }

  close(): void {
    this.ws.close();
  }
}

export interface Browser {
  proc: ChildProcess;
  profile: string;
  port: number;
}

/** Block this thread. The `exit` handler is synchronous: no promise settles there. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** How long to wait for a killed Chrome to actually go before removing its profile. */
const KILL_WAIT_MS = 3000;

/**
 * Kill Chrome, then remove the profile — synchronously, for the `exit`
 * handler. Order is the fix: wait for the pid to go, remove, then look once
 * more and remove again if anything reappeared.
 */
export function killAndRemove(proc: ChildProcess | undefined, profile: string): void {
  if (proc && proc.exitCode === null) proc.kill('SIGKILL');
  const pid = proc?.pid;
  if (pid !== undefined) {
    const deadline = Date.now() + KILL_WAIT_MS;
    while (Date.now() < deadline && isAlive(pid)) sleepSync(20);
  }
  rmSync(profile, { recursive: true, force: true });
  if (!existsSync(profile)) return;
  sleepSync(200);
  rmSync(profile, { recursive: true, force: true });
}

/**
 * Launch Chrome with `args` (build them with `chromeLaunchArgs`) and wait for
 * its CDP port.
 *
 * Port 0 lets Chrome pick a free port and announce it in
 * `<profile>/DevToolsActivePort`; deriving a port from the pid collided once
 * (two widths, same modulus) and two runs attached to each other's browser.
 *
 * `onSpawn` fires before the first `await`, so a signal during startup finds a
 * browser to clean up. Nothing here removes the profile on failure: the caller
 * has it registered and its cleanup is the one that waits for Chrome to die.
 */
export async function launchChrome(
  bin: string,
  args: (profile: string) => string[],
  timeoutMs: number,
  runId: string,
  onSpawn: (b: Browser) => void,
): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), profilePrefix(runId)));
  const proc = spawn(bin, args(profile), { stdio: ['ignore', 'ignore', 'pipe'] });
  const browser: Browser = { proc, profile, port: 0 };
  onSpawn(browser);
  let stderr = '';
  proc.stderr?.on('data', (d) => {
    stderr += String(d);
  });
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Chrome exited with ${proc.exitCode} before CDP came up:\n${stderr.trim()}`);
    }
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
      if (Number.isInteger(port) && port > 0) {
        browser.port = port;
        return browser;
      }
    }
    await sleep(50);
  }
  throw new Error(`CDP never came up within ${timeoutMs}ms:\n${stderr.trim()}`);
}

export async function pageSocketUrl(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no page target listed';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await r.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (e) {
      lastErr = String(e);
    }
    await sleep(50);
  }
  throw new Error(`no CDP page target on :${port}: ${lastErr}`);
}

export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
