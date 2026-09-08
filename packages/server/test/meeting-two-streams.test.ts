/**
 * The relay carrying a mic + Mac-audio meeting: two engine sessions, one
 * meeting, one record.
 *
 * `meeting-stream-set.test.ts` proves the fan-out in isolation. This is the
 * half that only the relay can answer — that the tagged frames a two-stream
 * client sends reach the right engine, that the durable record names both
 * sources and keeps a `.pcm` per stream, and that a microphone meeting on the
 * same relay is byte-for-byte what it always was.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMBINED_SOURCE,
  type MeetingServerMessage,
  type MeetingStreamId,
  tagAudioFrame,
} from '@claude-workspaces/core';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import { rawTranscriptPath, readMeetingJson } from '../src/meeting-raw.ts';
import { MeetingStore, meetingDirPath } from '../src/meetings.ts';
import type {
  TranscriptionEngine,
  TranscriptionOpenOpts,
  TranscriptionSession,
} from '../src/transcribe.ts';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * An engine that keeps every session it opened and lets the test speak into
 * whichever one it likes — the only way to drive two sessions of one meeting
 * independently, which is the whole subject here.
 */
function twoSessionEngine() {
  const sessions: Array<{ heard: Uint8Array[]; opts: TranscriptionOpenOpts }> = [];
  const engine: TranscriptionEngine = {
    name: 'twin',
    open(opts) {
      const entry = { heard: [] as Uint8Array[], opts };
      sessions.push(entry);
      const session: TranscriptionSession = {
        send: (audio) => entry.heard.push(Uint8Array.from(audio)),
        close: () => Promise.resolve(),
      };
      return Promise.resolve(session);
    },
  };
  return { engine, sessions };
}

/** One PCM frame whose bytes name the words a test expects to find again. */
const pcm = (marker: number) => new Uint8Array([marker, marker, marker, marker]);

describe('a meeting that hears the room and the Mac at once', () => {
  let dataDir: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-two-streams-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function meeting(docId: string, source: string | undefined) {
    const { engine, sessions } = twoSessionEngine();
    const sent: MeetingServerMessage[] = [];
    const store = new MeetingStore(dataDir);
    const relay = new MeetingRelay({ store, engines: [engine], notes: null, broadcast: () => {} });
    const ws: MeetingClient = {
      data: { docId },
      send: (payload) => sent.push(JSON.parse(payload) as MeetingServerMessage),
    };
    relay.onOpen(ws);
    relay.onText(
      ws,
      JSON.stringify({
        type: 'start',
        sampleRate: 16_000,
        encoding: 'pcm_s16le',
        mode: 'conversation',
        ...(source !== undefined ? { source } : {}),
      }),
    );
    await settle();
    const audio = (stream: MeetingStreamId, marker: number) =>
      relay.onAudio(
        ws,
        source === COMBINED_SOURCE ? tagAudioFrame(stream, pcm(marker)) : pcm(marker),
      );
    return {
      relay,
      ws,
      sent,
      sessions,
      store,
      audio,
      speak: (session: number, turn: { turn: number; text: string; speaker?: string }) =>
        sessions[session]?.opts.onTurn({ final: true, ...turn }),
      async stop() {
        relay.onText(ws, JSON.stringify({ type: 'stop' }));
        await settle();
      },
    };
  }

  it('opens one engine session per stream', async () => {
    const m = await meeting('two-open', COMBINED_SOURCE);
    expect(m.sessions).toHaveLength(2);
    await m.stop();
  });

  it('still opens exactly one session for an ordinary microphone meeting', async () => {
    const m = await meeting('one-open', undefined);
    expect(m.sessions).toHaveLength(1);
    await m.stop();
  });

  it('sends each stream’s audio to its own engine, stripped of the tag byte', async () => {
    const m = await meeting('two-route', COMBINED_SOURCE);
    m.audio('mic', 7);
    m.audio('system', 9);
    // The engines hear PCM, never the stream byte the socket carried.
    expect(m.sessions[0]?.heard.map((c) => [...c])).toEqual([[7, 7, 7, 7]]);
    expect(m.sessions[1]?.heard.map((c) => [...c])).toEqual([[9, 9, 9, 9]]);
    await m.stop();
  });

  it('drops a frame whose tag names no stream rather than guessing an engine', async () => {
    const m = await meeting('two-badtag', COMBINED_SOURCE);
    m.relay.onAudio(m.ws, new Uint8Array([200, 1, 2, 3]));
    expect(m.sessions[0]?.heard).toHaveLength(0);
    expect(m.sessions[1]?.heard).toHaveLength(0);
    await m.stop();
  });

  it('tells the client which group each turn came from', async () => {
    const m = await meeting('two-group', COMBINED_SOURCE);
    m.speak(0, { turn: 0, text: 'in the room', speaker: 'A' });
    m.speak(1, { turn: 0, text: 'on the call', speaker: 'A' });
    const turns = m.sent.filter((f) => f.type === 'transcript');
    expect(turns.map((t) => (t.type === 'transcript' ? t.group : null))).toEqual([
      'room',
      'remote',
    ]);
    // Two Speaker As that a person can name apart.
    expect(turns.map((t) => (t.type === 'transcript' ? t.speaker : null))).toEqual([
      'room:A',
      'remote:A',
    ]);
    await m.stop();
  });

  it('leaves a microphone meeting’s frames exactly as they were', async () => {
    const m = await meeting('one-group', undefined);
    m.speak(0, { turn: 0, text: 'just me', speaker: 'A' });
    const turn = m.sent.find((f) => f.type === 'transcript');
    expect(turn).toMatchObject({ speaker: 'A', turn: 0 });
    expect(turn && 'group' in turn ? turn.group : undefined).toBeUndefined();
    await m.stop();
  });

  it('keeps one durable transcript with both groups in it', async () => {
    const m = await meeting('two-record', COMBINED_SOURCE);
    m.speak(0, { turn: 0, text: 'in the room', speaker: 'A' });
    m.speak(1, { turn: 0, text: 'on the call', speaker: 'A' });
    await m.stop();
    const records = m.store.list('two-record');
    expect(records).toHaveLength(1);
    const turns = m.store.transcript('two-record', records[0]?.meetingId ?? '');
    expect(turns.map((t) => t.speaker)).toEqual(['room:A', 'remote:A']);
  });

  it('names both sources on the record and in the file a person opens', async () => {
    const m = await meeting('two-source', COMBINED_SOURCE);
    m.speak(0, { turn: 0, text: 'in the room', speaker: 'A' });
    await m.stop();
    expect(m.store.list('two-source')[0]?.source).toBe(COMBINED_SOURCE);
    const md = readFileSync(rawTranscriptPath(dataDir, 'two-source', 'two-source'), 'utf8');
    expect(md).toContain(`Source: ${COMBINED_SOURCE}`);
    // In words as well as in the stored value, so the file says what the
    // second source actually was.
    expect(md).toContain("microphone + this Mac's audio");
    // And the voices read apart on the page, not just in the JSONL.
    expect(md).toContain('Room Speaker A');
  });

  it('keeps a separate audio file per stream', async () => {
    const m = await meeting('two-audio', COMBINED_SOURCE);
    m.audio('mic', 3);
    m.audio('system', 4);
    await m.stop();
    const files = readdirSync(meetingDirPath(dataDir, 'two-audio')).filter((f) =>
      f.endsWith('.pcm'),
    );
    expect(files.sort()).toEqual(['segment-1-mic.pcm', 'segment-1-system.pcm']);
    // And each one holds only its own stream's bytes.
    const dir = meetingDirPath(dataDir, 'two-audio');
    expect([...readFileSync(join(dir, 'segment-1-mic.pcm'))]).toEqual([3, 3, 3, 3]);
    expect([...readFileSync(join(dir, 'segment-1-system.pcm'))]).toEqual([4, 4, 4, 4]);
    // meeting.json names the stream behind each file.
    const json = readMeetingJson(dataDir, 'two-audio');
    expect(json?.segments[0]?.audio.map((a) => a.stream).sort()).toEqual(['mic', 'system']);
  });

  it('names a Mac-audio-only meeting’s file after the stream it heard', async () => {
    const m = await meeting('one-system', 'system');
    m.relay.onAudio(m.ws, pcm(5));
    await m.stop();
    expect(existsSync(join(meetingDirPath(dataDir, 'one-system'), 'segment-1-system.pcm'))).toBe(
      true,
    );
  });

  it('refuses to measure a two-stream meeting, rather than measuring the wrong stream', async () => {
    const { engine, sessions } = twoSessionEngine();
    const sent: MeetingServerMessage[] = [];
    const relay = new MeetingRelay({
      store: new MeetingStore(dataDir),
      engines: [engine],
      notes: null,
      broadcast: () => {},
    });
    const ws: MeetingClient = {
      data: { docId: 'two-timing' },
      send: (p) => sent.push(JSON.parse(p) as MeetingServerMessage),
    };
    relay.onOpen(ws);
    relay.onText(
      ws,
      JSON.stringify({
        type: 'start',
        sampleRate: 16_000,
        encoding: 'pcm_s16le',
        mode: 'conversation',
        source: COMBINED_SOURCE,
        timing: true,
      }),
    );
    await settle();
    relay.onAudio(ws, tagAudioFrame('mic', pcm(1)));
    sessions[0]?.opts.onTurn({
      turn: 0,
      text: 'measured?',
      final: true,
      audioEndMs: 10,
      engineMs: 5,
    });
    const turn = sent.find((f) => f.type === 'transcript');
    // The ledger correlates a turn to a chunk by an offset into ONE engine's
    // stream, and two engines have two of those.
    expect(turn && 'timing' in turn ? turn.timing : undefined).toBeUndefined();
    relay.onText(ws, JSON.stringify({ type: 'stop' }));
    await settle();
  });

  it('replays audio buffered during the handshake to the right stream', async () => {
    // A person is mid-sentence when they press start; both engines are still
    // opening and the words belong to whichever stream carried them.
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const opened: Array<{ heard: Uint8Array[] }> = [];
    const engine: TranscriptionEngine = {
      name: 'slow',
      async open() {
        await held;
        const entry = { heard: [] as Uint8Array[] };
        opened.push(entry);
        return {
          send: (a: Uint8Array) => entry.heard.push(Uint8Array.from(a)),
          close: async () => {},
        };
      },
    };
    const relay = new MeetingRelay({
      store: new MeetingStore(dataDir),
      engines: [engine],
      notes: null,
      broadcast: () => {},
    });
    const ws: MeetingClient = { data: { docId: 'two-buffered' }, send: () => {} };
    relay.onOpen(ws);
    relay.onText(
      ws,
      JSON.stringify({
        type: 'start',
        sampleRate: 16_000,
        encoding: 'pcm_s16le',
        mode: 'conversation',
        source: COMBINED_SOURCE,
      }),
    );
    relay.onAudio(ws, tagAudioFrame('system', pcm(8)));
    release?.();
    await settle();
    await settle();
    expect(opened[0]?.heard).toHaveLength(0);
    expect(opened[1]?.heard.map((c) => [...c])).toEqual([[8, 8, 8, 8]]);
    relay.onText(ws, JSON.stringify({ type: 'stop' }));
    await settle();
  });
});
