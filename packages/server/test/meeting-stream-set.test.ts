import { describe, expect, test } from 'bun:test';
import { openMeetingStreamSet } from '../src/meeting-stream-set.ts';
import type { StreamTurn } from '../src/meeting-stream-set.ts';
import type {
  TranscriptionEngine,
  TranscriptionOpenOpts,
  TranscriptionSession,
} from '../src/transcribe.ts';

/**
 * A mic + Mac-audio meeting runs two engine sessions and has to keep one
 * transcript. These drive the set directly, with an engine that does nothing
 * but record what it was handed and emit exactly the turns a test asks it to,
 * because every failure this module exists to prevent is a COLLISION between
 * two sessions rather than anything either one of them does alone.
 */

interface Recorder {
  engine: TranscriptionEngine;
  /** One entry per session opened, in the order they were opened. */
  opened: Array<{
    /** Every chunk this session was sent, as a readable string. */
    heard: string[];
    closed: number;
    updated: Array<Record<string, unknown>>;
    emit(turn: { turn: number; text: string; final?: boolean; speaker?: string }): void;
  }>;
}

function recorder(opts: { failAt?: number; canUpdate?: boolean; closeFailsAt?: number } = {}) {
  const rec: Recorder = { engine: { name: 'rec', open }, opened: [] };
  function open(o: TranscriptionOpenOpts): Promise<TranscriptionSession> {
    const n = rec.opened.length;
    if (opts.failAt === n) return Promise.reject(new Error(`engine refused stream ${n}`));
    const entry = {
      heard: [] as string[],
      closed: 0,
      updated: [] as Array<Record<string, unknown>>,
      emit: (t: { turn: number; text: string; final?: boolean; speaker?: string }) =>
        o.onTurn({ final: true, ...t }),
    };
    rec.opened.push(entry);
    const session: TranscriptionSession = {
      send: (audio) => entry.heard.push(new TextDecoder().decode(audio)),
      close: () => {
        entry.closed += 1;
        return opts.closeFailsAt === n
          ? Promise.reject(new Error('close refused'))
          : Promise.resolve();
      },
      ...(opts.canUpdate === false
        ? {}
        : { update: (t: Record<string, unknown>) => entry.updated.push(t) }),
    };
    return Promise.resolve(session);
  }
  return rec;
}

const bytes = (s: string) => new TextEncoder().encode(s);

async function twoStreams(over: Parameters<typeof recorder>[0] = {}) {
  const rec = recorder(over);
  const turns: StreamTurn[] = [];
  const errors: Array<{ message: string; stream: string }> = [];
  const set = await openMeetingStreamSet({
    engine: rec.engine,
    streams: ['mic', 'system'],
    session: { sampleRate: 16_000, detectSpeakers: true },
    onTurn: (t) => turns.push(t),
    onError: (message, stream) => errors.push({ message, stream }),
  });
  return { rec, turns, errors, set };
}

describe('opening a set of streams', () => {
  test('opens one engine session per stream', async () => {
    const { rec } = await twoStreams();
    expect(rec.opened).toHaveLength(2);
  });

  test('opens one session, and namespaces nothing, for a single-stream meeting', async () => {
    const rec = recorder();
    const turns: StreamTurn[] = [];
    const set = await openMeetingStreamSet({
      engine: rec.engine,
      streams: ['mic'],
      session: { sampleRate: 16_000, detectSpeakers: true },
      onTurn: (t) => turns.push(t),
      onError: () => {},
    });
    expect(rec.opened).toHaveLength(1);
    expect(set.namespaced).toBe(false);
    rec.opened[0]?.emit({ turn: 0, text: 'hello', speaker: 'A' });
    // Byte-for-byte what a microphone meeting has always produced.
    expect(turns[0]?.speaker).toBe('A');
    expect(turns[0]?.turn).toBe(0);
    expect(turns[0]?.group).toBeUndefined();
  });

  test('closes the session it already opened when a later one is refused', async () => {
    const rec = recorder({ failAt: 1 });
    await expect(
      openMeetingStreamSet({
        engine: rec.engine,
        streams: ['mic', 'system'],
        session: { sampleRate: 16_000, detectSpeakers: true },
        onTurn: () => {},
        onError: () => {},
      }),
    ).rejects.toThrow('engine refused stream 1');
    // The first session is a paid socket with nobody holding a handle to it.
    expect(rec.opened[0]?.closed).toBe(1);
  });

  test('refuses a set with no streams in it at all', async () => {
    const rec = recorder();
    await expect(
      openMeetingStreamSet({
        engine: rec.engine,
        streams: [],
        session: { sampleRate: 16_000, detectSpeakers: true },
        onTurn: () => {},
        onError: () => {},
      }),
    ).rejects.toThrow();
  });
});

describe('routing audio', () => {
  test('sends each stream’s audio only to that stream’s engine', async () => {
    const { rec, set } = await twoStreams();
    set.send('mic', bytes('room words'));
    set.send('system', bytes('remote words'));
    expect(rec.opened[0]?.heard).toEqual(['room words']);
    expect(rec.opened[1]?.heard).toEqual(['remote words']);
  });
});

describe('keeping two engines’ answers apart', () => {
  test('namespaces the same engine label into two different voices', async () => {
    const { rec, turns } = await twoStreams();
    rec.opened[0]?.emit({ turn: 0, text: 'in the room', speaker: 'A' });
    rec.opened[1]?.emit({ turn: 0, text: 'on the call', speaker: 'A' });
    expect(turns[0]?.speaker).toBe('room:A');
    expect(turns[1]?.speaker).toBe('remote:A');
    expect(turns[0]?.speaker).not.toBe(turns[1]?.speaker);
  });

  test('stamps every turn with the group it came from', async () => {
    const { rec, turns } = await twoStreams();
    rec.opened[0]?.emit({ turn: 0, text: 'in the room' });
    rec.opened[1]?.emit({ turn: 0, text: 'on the call' });
    expect(turns.map((t) => t.group)).toEqual(['room', 'remote']);
    expect(turns.map((t) => t.stream)).toEqual(['mic', 'system']);
  });

  test('gives two streams’ turn zero two different ids', async () => {
    const { rec, turns } = await twoStreams();
    rec.opened[0]?.emit({ turn: 0, text: 'in the room' });
    rec.opened[1]?.emit({ turn: 0, text: 'on the call' });
    expect(turns[0]?.turn).not.toBe(turns[1]?.turn);
  });

  test('gives a revised turn the id it already had, so a correction lands in place', async () => {
    const { rec, turns } = await twoStreams();
    rec.opened[1]?.emit({ turn: 0, text: 'on the', final: false });
    rec.opened[0]?.emit({ turn: 0, text: 'in the room' });
    rec.opened[1]?.emit({ turn: 0, text: 'on the call' });
    expect(turns[0]?.turn).toBe(turns[2]?.turn);
    expect(turns[2]?.text).toBe('on the call');
  });

  test('never hands out an id below one it already gave, however far apart the streams run', async () => {
    const { rec, turns } = await twoStreams();
    // The room talks through nine turns before the call says anything.
    for (let t = 0; t < 9; t++) rec.opened[0]?.emit({ turn: t, text: `room ${t}` });
    rec.opened[1]?.emit({ turn: 0, text: 'first remote words' });
    rec.opened[0]?.emit({ turn: 9, text: 'room 9' });
    const fresh = turns.map((t) => t.turn);
    // The strip drops a turn whose id is below the newest it has seen, so a
    // backwards id here is a sentence that never reaches the screen.
    expect(fresh.every((id, i) => i === 0 || id > (fresh[i - 1] as number))).toBe(true);
  });
});

describe('tuning and closing', () => {
  test('applies live tuning to every session and says it landed', async () => {
    const { rec, set } = await twoStreams();
    expect(set.update({ end_of_turn_confidence_threshold: 0.5 })).toBe(true);
    expect(rec.opened[0]?.updated).toHaveLength(1);
    expect(rec.opened[1]?.updated).toHaveLength(1);
  });

  test('says nothing was applied on an engine with no update channel', async () => {
    const { set, rec } = await twoStreams({ canUpdate: false });
    expect(set.update({ end_of_turn_confidence_threshold: 0.5 })).toBe(false);
    expect(rec.opened[0]?.updated ?? []).toHaveLength(0);
  });

  test('closes every session, so neither engine is left billing', async () => {
    const { rec, set } = await twoStreams();
    await set.close();
    expect(rec.opened.map((o) => o.closed)).toEqual([1, 1]);
  });

  test('still closes the second session when the first refuses to close', async () => {
    const { rec, set } = await twoStreams({ closeFailsAt: 0 });
    await expect(set.close()).rejects.toThrow('close refused');
    // The point of the allSettled: one engine's failure must not keep the
    // other's final sentence out of the record.
    expect(rec.opened[1]?.closed).toBe(1);
  });

  test('names the stream an engine error came from', async () => {
    const rec = recorder();
    const errors: Array<{ message: string; stream: string }> = [];
    await openMeetingStreamSet({
      engine: {
        name: 'rec',
        open: (o) => {
          queueMicrotask(() => o.onError('engine dropped'));
          return rec.engine.open(o);
        },
      },
      streams: ['mic', 'system'],
      session: { sampleRate: 16_000, detectSpeakers: true },
      onTurn: () => {},
      onError: (message, stream) => errors.push({ message, stream }),
    });
    await new Promise((r) => queueMicrotask(() => r(null)));
    expect(errors.map((e) => e.stream).sort()).toEqual(['mic', 'system']);
  });
});
