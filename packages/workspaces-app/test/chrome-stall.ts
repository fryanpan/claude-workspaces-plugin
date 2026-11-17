/**
 * What the lead chat's voice drivers say when Chrome stops answering.
 *
 * Three of them (meeting, link-tabs, the chat itself) fail on CI at 430 with
 * voice on, and the failures named only the step: a `Runtime.evaluate` that
 * got no answer in 15s, or a driver killed at its 230s deadline after its
 * last step. Neither says whether Chrome was alive, whether the renderer had
 * crashed, or what the tab was showing. Every local run passes, so CI is the
 * only place to find out, and this is how it says.
 *
 * `boundCdp` gives every CDP call on a client a limit. When one runs out it
 * writes, and throws, the browser's state: whether the process is running,
 * any renderer crash CDP reported, the targets `/json/list` holds, and the
 * last lines Chrome wrote to stderr (launched with `CHROME_LOG_ARGS`).
 * `chromeState` is the same dump, for a driver failing in some other way.
 */
import type { ChildProcess } from 'node:child_process';
import { type Browser, Cdp, pageSocketUrl, withTimeout } from '../../../scripts/headless-chrome.ts';
import { STARTUP_TIMEOUT_MS } from '../../../scripts/ui-shot-lib.ts';

/** Chrome's own log, on the stderr `launchChrome` already pipes. */
export const CHROME_LOG_ARGS: readonly string[] = ['--enable-logging=stderr', '--v=0'];

/** One CDP answer. Generous: a loaded runner answers in well under a second. */
export const CDP_MS = 15_000;
/** How many of Chrome's stderr lines a dump carries. */
const TAIL_LINES = 80;
/** A dump per watched browser at most this often, so a loop of stalls does
 *  not bury the first one. */
const MAX_DUMPS = 3;

export interface ChromeWatch {
  port: number;
  proc: Pick<ChildProcess, 'exitCode' | 'signalCode'>;
  /** The last lines Chrome wrote to stderr. */
  lines: string[];
  /** Renderer crashes CDP reported, by client label. */
  crashed: string[];
  dumps: number;
}

/** Every browser this process watches, for `dumpRunning`. */
const watched: ChromeWatch[] = [];
/** The browser each bounded client talks to, for `onceWithin`. */
const watchOfCdp = new WeakMap<Cdp, ChromeWatch>();

/** Start keeping the tail of `b`'s stderr. Call it as soon as it launched. */
export function watchChrome(b: Browser): ChromeWatch {
  const w: ChromeWatch = { port: b.port, proc: b.proc, lines: [], crashed: [], dumps: 0 };
  let partial = '';
  b.proc.stderr?.on('data', (d) => {
    const parts = (partial + String(d)).split('\n');
    partial = parts.pop() ?? '';
    w.lines.push(...parts);
    if (w.lines.length > TAIL_LINES) w.lines.splice(0, w.lines.length - TAIL_LINES);
  });
  watched.push(w);
  return w;
}

/** The watch `boundCdp` gave `cdp`, for a second tab of the same browser. */
export function watchOf(cdp: Cdp): ChromeWatch | undefined {
  return watchOfCdp.get(cdp);
}

/** `b`'s first page, watched and bounded: the drivers' usual opening. */
export async function connectWatched(
  b: Browser,
  label: string,
  log: (text: string) => void,
): Promise<Cdp> {
  const w = watchChrome(b);
  return boundCdp(
    await Cdp.connect(await pageSocketUrl(b.port, STARTUP_TIMEOUT_MS)),
    w,
    label,
    log,
  );
}

/** The browser as it is now: process, crashes, targets, stderr tail. */
export async function chromeState(w: ChromeWatch): Promise<string> {
  let targets: string;
  try {
    const res = await fetch(`http://127.0.0.1:${w.port}/json/list`, {
      signal: AbortSignal.timeout(3000),
    });
    const list = (await res.json()) as Array<{ type: string; url: string; title?: string }>;
    targets = JSON.stringify(list.map((t) => ({ type: t.type, url: t.url, title: t.title })));
  } catch (e) {
    targets = `no answer (${e instanceof Error ? e.message : String(e)})`;
  }
  const { exitCode, signalCode } = w.proc;
  const proc =
    exitCode === null && signalCode === null ? 'running' : `exited (${exitCode ?? signalCode})`;
  return [
    `[chrome] process ${proc}`,
    ...w.crashed.map((c) => `[chrome] ${c}`),
    `[chrome] /json/list: ${targets}`,
    `[chrome] stderr, last ${w.lines.length} lines:`,
    ...w.lines.map((l) => `  ${l}`),
  ].join('\n');
}

/**
 * Bound every `send` on `cdp` (and so every `evaluate`, which sends) to `ms`.
 * A call that runs out is written to `log` with the browser's state and
 * thrown with it, so a caller that swallows the error still leaves the dump.
 */
export function boundCdp(
  cdp: Cdp,
  w: ChromeWatch,
  label: string,
  log: (text: string) => void,
  ms = CDP_MS,
): Cdp {
  const send = cdp.send.bind(cdp);
  cdp.send = async (method, params, sessionId) => {
    const what = `${label}: CDP ${method}`;
    try {
      return await withTimeout(send(method, params, sessionId), ms, what);
    } catch (e) {
      if (!(e instanceof Error) || e.message !== `${what} did not finish within ${ms}ms`) throw e;
      const state = w.dumps < MAX_DUMPS ? await chromeState(w) : '[chrome] (dump limit reached)';
      w.dumps++;
      log(`${e.message}\n${state}`);
      throw new Error(`${e.message}\n${state}`);
    }
  };
  cdp.on('Inspector.targetCrashed', () => {
    w.crashed.push(`${label}: renderer crashed (Inspector.targetCrashed)`);
    log(`${label}: renderer crashed (Inspector.targetCrashed)`);
  });
  void send('Inspector.enable').catch(() => {});
  watchOfCdp.set(cdp, w);
  return cdp;
}

/** `cdp.once(method)`, bounded and named; dumped when `cdp` is watched.
 *  Settles quietly if nobody awaits it, so it can be armed before a call
 *  that may throw first. */
export function onceWithin(
  cdp: Cdp,
  method: string,
  log: (text: string) => void,
  ms = 30_000,
): Promise<unknown> {
  const what = `the ${method} event`;
  const p = withTimeout(cdp.once(method), ms, what).catch(async (e: unknown) => {
    const w = watchOfCdp.get(cdp);
    if (!w || !(e instanceof Error) || e.message !== `${what} did not finish within ${ms}ms`) {
      throw e;
    }
    const state = await chromeState(w);
    log(`${e.message}\n${state}`);
    throw new Error(`${e.message}\n${state}`);
  });
  p.catch(() => {});
  return p;
}

/** Every watched browser still running, dumped to `log`. For a driver's
 *  failure path and its overall deadline, before the browsers are stopped. */
export async function dumpRunning(log: (text: string) => void): Promise<void> {
  for (const w of watched) {
    if (w.proc.exitCode === null && w.proc.signalCode === null) log(await chromeState(w));
  }
}
