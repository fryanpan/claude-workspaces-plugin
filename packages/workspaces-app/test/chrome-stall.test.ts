// @vitest-environment node
/**
 * A lead-chat voice driver whose browser stops answering says what the
 * browser was doing, instead of only the step it was on.
 */
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Cdp, CdpResult } from '../../../scripts/headless-chrome.ts';
import { type ChromeWatch, boundCdp, chromeState, onceWithin } from './chrome-stall.ts';

const never = <T>(): Promise<T> => new Promise<T>(() => {});

/** A CDP client whose `Runtime.evaluate` never answers and whose other
 *  methods answer at once. `fire` raises an event on it. */
function fakeCdp(): { cdp: Cdp; fire: (method: string) => void } {
  const listeners = new Map<string, Array<() => void>>();
  const cdp = {
    send: (method: string): Promise<CdpResult> =>
      method === 'Runtime.evaluate' ? never() : Promise.resolve({ answered: method }),
    on: (method: string, fn: () => void) => {
      listeners.set(method, [...(listeners.get(method) ?? []), fn]);
    },
    once: () => never(),
  } as unknown as Cdp;
  return { cdp, fire: (m) => (listeners.get(m) ?? []).forEach((fn) => fn()) };
}

let server: Server;
let port = 0;
beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify([
        { type: 'page', url: 'http://127.0.0.1/workspaces/w-1/home', title: 'Home' },
      ]),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
});

const watch = (): ChromeWatch => ({
  port,
  proc: { exitCode: null, signalCode: null },
  lines: ['ERROR:gpu_init.cc a line Chrome wrote'],
  crashed: [],
  dumps: 0,
});

describe('a driver’s browser that stops answering', () => {
  it('names the CDP call, and dumps the process, its targets and its log', async () => {
    const { cdp } = fakeCdp();
    const logged: string[] = [];
    const bounded = boundCdp(cdp, watch(), 'page at 430', (t) => logged.push(t), 20);
    const err = await bounded.send('Runtime.evaluate', {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const text = (err as Error).message;
    expect(text).toContain('page at 430: CDP Runtime.evaluate did not finish within 20ms');
    expect(text).toContain('[chrome] process running');
    expect(text).toContain('/workspaces/w-1/home');
    expect(text).toContain('a line Chrome wrote');
    // Logged as well, for a caller that swallows the error.
    expect(logged).toEqual([text]);
  });

  it('passes an answer through unchanged', async () => {
    const bounded = boundCdp(fakeCdp().cdp, watch(), 'page', () => {}, 20);
    await expect(bounded.send('Page.enable', {})).resolves.toEqual({ answered: 'Page.enable' });
  });

  it('records a renderer crash, and the next dump names it', async () => {
    const { cdp, fire } = fakeCdp();
    const w = watch();
    const logged: string[] = [];
    boundCdp(cdp, w, 'page at 430', (t) => logged.push(t), 20);
    fire('Inspector.targetCrashed');
    expect(logged).toEqual(['page at 430: renderer crashed (Inspector.targetCrashed)']);
    expect(await chromeState(w)).toContain('page at 430: renderer crashed');
  });

  it('says so when the browser has exited and its port is gone', async () => {
    const w = { ...watch(), port: 1, proc: { exitCode: null, signalCode: 'SIGKILL' as const } };
    const text = await chromeState(w);
    expect(text).toContain('[chrome] process exited (SIGKILL)');
    expect(text).toContain('/json/list: no answer');
  });

  it('bounds an event wait and dumps the same way', async () => {
    const cdp = boundCdp(fakeCdp().cdp, watch(), 'page', () => {}, 20);
    const err = await onceWithin(cdp, 'Page.loadEventFired', () => {}, 20).catch((e: Error) => e);
    expect((err as Error).message).toContain(
      'the Page.loadEventFired event did not finish within 20ms',
    );
    expect((err as Error).message).toContain('a line Chrome wrote');
  });
});
