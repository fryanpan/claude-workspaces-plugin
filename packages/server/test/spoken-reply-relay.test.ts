/**
 * The relay on its own: one session per socket, the upgrade's read-only
 * verdict carried into it, and a closed socket's session dropped.
 */
import { describe, expect, it } from 'bun:test';
import {
  SpokenReplyRelay,
  type SpokenReplyRelayDeps,
  type SpokenWs,
} from '../src/spoken-reply/relay.ts';
import type { SpokenEngines } from '../src/spoken-reply/session.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../src/transcribe.ts';

const NONE: SpokenEngines = { listener: null, voices: { 1: null, 2: null }, gemini: null };
const SOME: SpokenEngines = {
  listener: {} as TranscriptionEngine,
  voices: { 1: {} as SpokenVoice, 2: null },
  gemini: null,
};

function relay(engines: SpokenEngines, extra: Partial<SpokenReplyRelayDeps> = {}) {
  return new SpokenReplyRelay({
    ...extra,
    engines,
    board: {
      handle: async () => {
        throw new Error('not reached');
      },
      goalStatus: () => undefined,
      goals: () => [],
    },
    timings: new SpokenTimings(undefined, () => {}),
    parseContext: () => undefined,
  });
}

function socket(data: SpokenWs['data']) {
  const sent: Array<Record<string, unknown>> = [];
  const ws: SpokenWs = {
    data,
    send: (p) => {
      if (typeof p === 'string') sent.push(JSON.parse(p) as Record<string, unknown>);
    },
  };
  return { ws, sent };
}

describe('SpokenReplyRelay', () => {
  it('names only the setups whose engines were built', () => {
    expect(relay(NONE).setups()).toEqual([]);
    expect(relay(SOME).setups()).toEqual([1]);
  });

  it('greets each socket with the setups, and a read-only one cannot start', () => {
    const r = relay(SOME);
    const { ws, sent } = socket({ workspaceId: 'w-1', readOnly: true });
    r.onOpen(ws);
    expect(sent[0]).toMatchObject({ type: 'ready', setups: [1] });
    r.onText(ws, JSON.stringify({ type: 'start', setup: 1, mode: 'hold' }));
    expect(sent.at(-1)).toEqual({ type: 'error', message: 'Sign in to use the mic.' });
  });

  it('a setup the server lacks is refused, and a closed socket is forgotten', () => {
    const r = relay(SOME);
    const { ws, sent } = socket({ workspaceId: 'w-1' });
    r.onOpen(ws);
    r.onText(ws, JSON.stringify({ type: 'start', setup: 2, mode: 'hold' }));
    expect(sent.at(-1)).toEqual({
      type: 'error',
      message: 'Setup 2 is not set up on this server.',
    });
    r.onClose(ws);
    const before = sent.length;
    r.onText(ws, JSON.stringify({ type: 'start', setup: 2, mode: 'hold' }));
    expect(sent.length).toBe(before);
  });

  it('beats on each open socket at the interval it is given, and stops at close', () => {
    // The scheduler is a fake: each tick is a call the test makes.
    const timers: Array<{ ms: number; tick: () => void; stopped: boolean }> = [];
    const r = relay(SOME, {
      keepaliveMs: 30_000,
      every: (tick, ms) => {
        const t = { ms, tick, stopped: false };
        timers.push(t);
        return () => {
          t.stopped = true;
        };
      },
      log: () => {},
    });
    const { ws, sent } = socket({ workspaceId: 'w-1' });
    r.onOpen(ws);
    expect(timers.map((t) => t.ms)).toEqual([30_000]);
    const greeted = sent.length;
    timers[0]?.tick();
    timers[0]?.tick();
    expect(sent.slice(greeted)).toEqual([{ type: 'keepalive' }, { type: 'keepalive' }]);
    r.onClose(ws, 1006);
    expect(timers[0]?.stopped).toBe(true);
  });

  it('logs one line per close, naming the code and how long the socket was open', () => {
    const lines: string[] = [];
    let at = 1_000;
    const r = relay(SOME, { every: () => () => {}, log: (l) => lines.push(l), now: () => at });
    const { ws } = socket({ workspaceId: 'w-harbor' });
    r.onOpen(ws);
    at += 98_400;
    r.onClose(ws, 1006);
    expect(lines).toEqual(['[spoken] socket closed workspace=w-harbor code=1006 open=98s']);
    r.onClose(ws, 1006);
    expect(lines.length).toBe(1);
  });
});
