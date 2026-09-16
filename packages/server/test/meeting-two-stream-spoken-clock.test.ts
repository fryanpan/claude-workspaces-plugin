/**
 * The spoken clock on a mic + Mac-audio meeting, through the REAL server
 * socket and into the timing file a latency report reads.
 *
 * The last-word-spoken clock is what the ten-second goal is written against,
 * and for as long as one ledger counted the bytes of both streams it was null
 * on every tick of every combined capture — so the only meetings the goal
 * could be checked on were the solo ones. The relay now keeps one ledger per
 * stream, which is what makes the arithmetic true again: each ledger counts
 * exactly the audio its own engine was fed.
 *
 * Two things are asserted, and the second is the one a shared ledger would
 * still pass by accident:
 *
 * 1. Every tick row in `<meetingId>-timing.jsonl` carries `lastSpokenAt`.
 * 2. The clock a SYSTEM turn resolves to is read off the system stream's own
 *    audio, not off whatever the microphone had sent by then.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMBINED_SOURCE,
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  type MeetingStreamId,
  meetingSocketPath,
  tagAudioFrame,
} from '@claude-workspaces/core';
import {
  type NotesUpdate,
  type TickScheduler,
  createStubNotesComposer,
} from '../src/meeting-notes.ts';
import { meetingTimingPath } from '../src/meetings.ts';
import type { NotesTickTiming } from '../src/notes-timing.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

/** 100ms of 16 kHz mono PCM16. */
const FRAME_BYTES = (MEETING_SAMPLE_RATE / 10) * 2;
/** Bytes of this audio per millisecond. */
const BYTES_PER_MS = (MEETING_SAMPLE_RATE * 2) / 1000;

/**
 * An engine that opens a session per stream and hands each one back to the
 * test, counting the audio THAT session was fed — which is what makes a turn
 * reportable at an offset into its own stream, the way a real engine reports.
 */
function perStreamEngine() {
  const sessions: Array<{ bytes: number; opts: TranscriptionOpenOpts }> = [];
  const engine: TranscriptionEngine = {
    name: 'per-stream-mock',
    open(opts) {
      const entry = { bytes: 0, opts };
      sessions.push(entry);
      return Promise.resolve({
        send(audio: Uint8Array): void {
          entry.bytes += audio.byteLength;
        },
        close: () => Promise.resolve(),
      });
    },
  };
  return { engine, sessions };
}

let WS = '';

describe('a mic + Mac-audio meeting knows when its last word was said', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  const updates: NotesUpdate[] = [];
  const timers: Array<() => void> = [];
  const { engine, sessions } = perStreamEngine();
  /** Fire the notes tick by hand, exactly as the other meeting suites do. */
  const schedule: TickScheduler = {
    set(fn) {
      timers.push(fn);
      return timers.length;
    },
    clear() {},
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-two-stream-spoken-'));
    handle = createServer({
      port: 0,
      dataDir,
      transcription: engine,
      meetingNotes: {
        composer: createStubNotesComposer(),
        quietMs: 1_000,
        schedule,
        onNotes: (u) => {
          updates.push(u);
        },
      },
    });
    base = `http://127.0.0.1:${handle.port}`;
    WS = await seedBoard(base);
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function openDoc(docId: string): Promise<string> {
    const path = join(dataDir, `${docId}.md`);
    writeFileSync(path, `# ${docId}\n\nNotes go here.\n`);
    const created = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, sourceUrl: path, title: docId }),
    });
    expect(created.status, await created.clone().text()).toBe(200);
    return ((await created.json()) as { docId: string }).docId;
  }

  /**
   * A socket already past `ready`, opened on the combined source — with the
   * two sessions THIS meeting opened, since the engine above accumulates
   * every session of the file and the indices move with each meeting.
   */
  async function record(docId: string): Promise<{
    ws: WebSocket;
    session: (stream: MeetingStreamId) => { bytes: number; opts: TranscriptionOpenOpts };
  }> {
    const first = sessions.length;
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}${meetingSocketPath(WS, docId)}`);
    ws.binaryType = 'arraybuffer';
    const ready = new Promise<void>((resolve, reject) => {
      ws.addEventListener('message', (ev) => {
        const frame = JSON.parse(ev.data as string) as { type: string };
        if (frame.type === 'ready') resolve();
        if (frame.type === 'unavailable') reject(new Error(ev.data as string));
      });
      ws.addEventListener('error', () => reject(new Error('audio socket refused')));
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('audio socket refused')));
    });
    ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
        mode: 'conversation',
        source: COMBINED_SOURCE,
      }),
    );
    await ready;
    // Both sessions are opened in sequence behind the handshake; nothing may
    // be spoken until the one this test drives exists.
    await waitFor(() => sessions.length >= first + 2, {
      describe: 'both engine sessions to open',
    });
    return {
      ws,
      // Opened in the order `streamsForSource` names them: mic, then system.
      session: (stream) => {
        const entry = sessions[first + (stream === 'mic' ? 0 : 1)];
        if (!entry) throw new Error(`no session for ${stream}`);
        return entry;
      },
    };
  }

  const speak = (stream: MeetingStreamId, ws: WebSocket, frames: number): void => {
    for (let i = 0; i < frames; i++) {
      ws.send(tagAudioFrame(stream, new Uint8Array(FRAME_BYTES)));
    }
  };

  /** Settle a turn at the end of everything that stream's engine has heard. */
  const settleTurn = async (
    entry: { bytes: number; opts: TranscriptionOpenOpts },
    stream: MeetingStreamId,
    turn: number,
    text: string,
  ): Promise<void> => {
    // Poll rather than sleep: the frames above are still crossing the socket.
    const bytes = await waitFor(() => (entry.bytes > 0 ? entry.bytes : false), {
      describe: `${stream}'s engine to hear its audio`,
    });
    entry.opts.onTurn({ turn, text, final: true, audioEndMs: bytes / BYTES_PER_MS });
  };

  async function timingRows(docId: string): Promise<NotesTickTiming[]> {
    const list = (await (
      await fetch(`${base}/workspaces/${WS}/docs/${docId}/meetings`)
    ).json()) as {
      meetings: Array<{ meetingId: string }>;
    };
    const meetingId = list.meetings[0]?.meetingId ?? '';
    return readFileSync(meetingTimingPath(dataDir, docId, meetingId), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as NotesTickTiming);
  }

  it('writes a last-word-spoken clock on every tick of a two-stream meeting', async () => {
    const docId = await openDoc('combined-spoken');
    const { ws, session } = await record(docId);

    speak('mic', ws, 3);
    await settleTurn(session('mic'), 'mic', 0, 'we should ship it');
    speak('system', ws, 2);
    await settleTurn(session('system'), 'system', 0, 'agreed, ship it');

    for (const fire of timers.splice(0)) fire();
    await waitFor(() => updates.length > 0, { describe: 'the notes tick to write' });

    const rows = await timingRows(docId);
    expect(rows.length).toBeGreaterThan(0);
    // Every row, not only the written one: a tick that carried speech knows
    // when that speech ended whatever the compose then did with it.
    for (const row of rows) {
      expect(row.lastSpokenAt).not.toBeNull();
      expect(row.lastSpokenAt ?? 0).toBeGreaterThanOrEqual(row.spokenAt ?? 0);
    }
    const written = rows.find((r) => r.outcome === 'written');
    expect(written?.lastSpokenToWrittenMs).not.toBeNull();
    // The wait measured from the last word is the shorter one: the speaker
    // stopped after they started.
    expect(written?.lastSpokenToWrittenMs ?? 0).toBeLessThanOrEqual(
      written?.spokenToWrittenMs ?? 0,
    );
    ws.close();
  });

  it('reads the Mac-audio stream’s clock off its own audio, not the microphone’s', async () => {
    // The discriminating case, and the one a shared ledger would still fail
    // after the nulls were gone: the microphone has carried four seconds of
    // audio by the time the Mac's engine settles a turn at an offset of one
    // frame into its OWN stream. A ledger counting both streams resolves that
    // small offset to a chunk the microphone sent at the very start of the
    // meeting, and reports the remote voice as having spoken back then — so
    // the second tick's clock would come out EARLIER than the first's.
    //
    // Both clocks are read out of the timing file, so nothing here is timed
    // against the machine's own wall clock.
    const docId = await openDoc('combined-streams-apart');
    const { ws, session } = await record(docId);

    speak('mic', ws, 40);
    await settleTurn(session('mic'), 'mic', 0, 'the room has been talking a while');
    const before = updates.length;
    for (const fire of timers.splice(0)) fire();
    await waitFor(() => updates.length > before, { describe: 'the room’s tick to write' });

    speak('system', ws, 1);
    await settleTurn(session('system'), 'system', 0, 'and now the call speaks');
    for (const fire of timers.splice(0)) fire();
    await waitFor(() => updates.length > before + 1, { describe: 'the call’s tick to write' });

    const rows = (await timingRows(docId)).filter((r) => r.lastSpokenAt !== null);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const room = rows[0]?.lastSpokenAt ?? 0;
    const call = rows[1]?.lastSpokenAt ?? 0;
    expect(call).toBeGreaterThanOrEqual(room);
    ws.close();
  });
});
