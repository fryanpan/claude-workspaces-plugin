/**
 * The mock page's load report stops its content clock when the mock document
 * is parsed, not when the mock's own images and scripts from other servers
 * finish. The frame's `load` is still reported, as `msToFrameLoad`. The real
 * browser walk, with a slow image on another server, is
 * `mock-load-report-browser.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportMockLoad } from '../src/mock-host.ts';

type Listener = (ev: MessageEvent) => void;

function rig() {
  let t = 0;
  const frameWindow = {} as Window;
  const loads: Array<() => void> = [];
  const frame = {
    contentWindow: frameWindow,
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'load') loads.push(fn);
    },
  } as unknown as HTMLIFrameElement;
  const posted: Array<Record<string, unknown>> = [];
  const post = vi.fn(async (_path: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response('{}');
  });
  let heard: Listener = () => {};
  reportMockLoad(
    frame,
    'w-harbor',
    post,
    (fn) => {
      heard = fn;
    },
    () => t,
  );
  const say = (cw: string, source: unknown = frameWindow) =>
    heard({ data: { cw }, source } as unknown as MessageEvent);
  return {
    at: (ms: number) => {
      t = ms;
    },
    say,
    load: () => {
      for (const fn of loads) fn();
    },
    posted,
    post,
  };
}

describe('the mock load report', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stamps content when the frame is parsed and reports the frame load beside it', () => {
    const r = rig();
    r.at(40);
    r.say('frame-start');
    r.at(52);
    r.say('frame-ready');
    r.at(3051);
    r.load();
    expect(r.post).toHaveBeenCalledTimes(1);
    expect(r.post.mock.calls[0]?.[0]).toBe('/workspaces/w-harbor/load-reports');
    expect(r.posted[0]).toEqual({
      page: 'mock',
      msToBoot: 0,
      msToFrameStart: 40,
      msToContent: 52,
      msToFrameLoad: 3051,
    });
  });

  it('falls back to the frame load when no bridge said the frame was ready', () => {
    const r = rig();
    r.at(70);
    r.load();
    expect(r.posted[0]).toEqual({ page: 'mock', msToBoot: 0, msToContent: 70, msToFrameLoad: 70 });
  });

  it('reports the parsed stamp at the deadline when the frame load never comes', () => {
    const r = rig();
    r.at(60);
    r.say('frame-ready');
    vi.advanceTimersByTime(15_000);
    expect(r.posted[0]).toEqual({ page: 'mock', msToBoot: 0, msToContent: 60 });
  });

  it('ignores words from any window but the frame, and words after it reported', () => {
    const r = rig();
    r.at(5);
    r.say('frame-ready', {});
    r.at(90);
    r.load();
    r.at(95);
    r.say('frame-ready');
    r.load();
    expect(r.post).toHaveBeenCalledTimes(1);
    expect(r.posted[0]?.msToContent).toBe(90);
  });
});
