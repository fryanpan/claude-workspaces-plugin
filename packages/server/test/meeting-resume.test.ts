/**
 * A meeting picked back up after the server it was running on went away.
 *
 * The socket is the meeting's lifecycle, so a restart used to end the
 * recording: the next `start` minted a new meeting id, a new transcript file
 * and a second notes section under one conversation. A client that keeps its
 * microphone open and asks for the SAME meeting gets one recording back — and
 * the half of that this file is about is what the server owes it: the
 * transcript continues, the turn numbers run on rather than landing on top of
 * the words already stored, the notes section is the one the meeting opened,
 * and a resume the server cannot honour opens a new meeting and SAYS so
 * rather than pretending.
 *
 * A real server, stopped and started over the same data dir — not a relay in a
 * harness — because the thing under test is what survived the process.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  meetingSocketPath,
} from '@claude-workspaces/core';
import {
  listMeetings,
  meetingDirPath,
  meetingSectionPath,
  meetingTranscriptPath,
} from '../src/meetings.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type MockScriptTurn, createMockTranscriptionEngine } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

// Two servers boot in one test and a socket round trip under a loaded machine
// has been measured in seconds; the waits below are polls, so a healthy run
// pays none of it. See meeting-socket.test.ts for the same reasoning.
setDefaultTimeout(30_000);

interface ServerFrame {
  type: string;
  [key: string]: unknown;
}

/** A meeting client: opens the socket, collects the JSON frames it is sent. */
class AudioClient {
  readonly frames: ServerFrame[] = [];
  private constructor(readonly ws: WebSocket) {}

  static async open(port: number, ws: string, docId: string): Promise<AudioClient> {
    const sock = new WebSocket(`ws://127.0.0.1:${port}${meetingSocketPath(ws, docId)}`);
    sock.binaryType = 'arraybuffer';
    const client = new AudioClient(sock);
    sock.addEventListener('message', (ev) => {
      client.frames.push(JSON.parse(ev.data as string) as ServerFrame);
    });
    await new Promise<void>((resolve, reject) => {
      sock.addEventListener('open', () => resolve());
      sock.addEventListener('error', () => reject(new Error('audio socket refused')));
    });
    return client;
  }

  start(extra: Record<string, unknown> = {}): void {
    this.ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
        mode: 'solo',
        ...extra,
      }),
    );
  }

  /** One 20ms frame of silence per chunk — the mock advances one step each. */
  speak(chunks: number): void {
    for (let i = 0; i < chunks; i++) this.ws.send(new Uint8Array(640));
  }

  stop(): void {
    this.ws.send(JSON.stringify({ type: 'stop' }));
  }

  waitFrame(type: string): Promise<ServerFrame> {
    return waitFor(() => this.frames.find((f) => f.type === type), {
      timeout: 15_000,
      describe: `a "${type}" frame (got ${JSON.stringify(this.frames.map((f) => f.type))})`,
    });
  }

  /** The settled turns this client has been sent, in arrival order. */
  finals(): Array<{ turn: number; text: string }> {
    return this.frames
      .filter((f) => f.type === 'transcript' && f.final === true)
      .map((f) => ({ turn: f.turn as number, text: f.text as string }));
  }
}

/** One settled line of the durable transcript. */
interface StoredTurn {
  turn: number;
  text?: string;
}

function storedTurns(dataDir: string, docId: string, meetingId: string): StoredTurn[] {
  return readFileSync(meetingTranscriptPath(dataDir, docId, meetingId), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as StoredTurn);
}

interface Booted {
  handle: ServerHandle;
  base: string;
  port: number;
}

describe('resuming a meeting across a server restart', () => {
  let dataDir = '';
  const running: ServerHandle[] = [];

  const boot = (script?: readonly MockScriptTurn[]): Booted => {
    const handle = createServer({
      port: 0,
      dataDir,
      transcription: script
        ? createMockTranscriptionEngine(script)
        : createMockTranscriptionEngine(),
    });
    running.push(handle);
    return { handle, base: `http://127.0.0.1:${handle.port}`, port: handle.port };
  };

  afterEach(async () => {
    for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
  });

  /** A doc on a fresh board, returning everything the sockets need. */
  const seed = async (docId: string) => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-resume-'));
    const first = boot();
    const ws = await seedBoard(first.base);
    const path = join(dataDir, `${docId}.md`);
    writeFileSync(path, `# ${docId}\n\nNotes go here.\n`);
    const res = await fetch(`${first.base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, sourceUrl: path, title: docId }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const canonical = ((await res.json()) as { docId: string }).docId;
    return { first, ws, canonical };
  };

  it('continues the same transcript, section and turn numbering', async () => {
    const { first, ws, canonical } = await seed('resume-me');

    const before = await AudioClient.open(first.port, ws, 'resume-me');
    before.start();
    const ready = await before.waitFrame('ready');
    const meetingId = String(ready.meetingId);
    expect(ready.resumed).toBeUndefined();
    // Seven chunks reveal and settle the mock's first turn.
    before.speak(7);
    await waitFor(() => before.finals().length === 1, { describe: 'the first turn to settle' });
    const firstLeg = before.finals();
    expect(firstLeg[0]?.turn).toBe(0);

    // The restart: a graceful stop, which is what a deploy does — it flushes
    // every live meeting on the way out, so the resumed leg finds a meeting
    // the index already calls ended.
    await first.handle.stop();
    running.length = 0;
    before.ws.close();
    const stored = storedTurns(dataDir, canonical, meetingId);
    expect(stored.map((t) => t.turn)).toEqual([0]);

    // A different script on the second process, so the words the resumed leg
    // appends can be told apart from the ones already in the file: a session
    // starts its own script at zero, exactly as a fresh engine session does.
    const second = boot([
      { words: ['and', 'now', 'we', 'are', 'back'], settled: 'And now we are back.' },
    ]);
    const after = await AudioClient.open(second.port, ws, 'resume-me');
    after.start({ resume: meetingId });
    const back = await after.waitFrame('ready');

    // The same recording, said in the answer rather than inferred: same id,
    // and the ORIGINAL start time, so the strip's clock counts the meeting
    // rather than the leg.
    expect(back.resumed).toBe(true);
    expect(back.meetingId).toBe(meetingId);
    expect(back.startedAt).toBe(ready.startedAt);

    after.speak(6);
    await waitFor(() => after.finals().length === 1, { describe: 'the resumed turn to settle' });
    // The engine numbers its own turns from zero on every session. What the
    // client is sent — and what lands in the file — runs ON from the words
    // already recorded, because a second line for a turn already written is a
    // REVISION of it in this format, not a new turn.
    expect(after.finals()[0]?.turn).toBe(1);

    after.stop();
    await after.waitFrame('stopped');
    after.ws.close();

    const all = storedTurns(dataDir, canonical, meetingId);
    expect(all.map((t) => t.turn)).toEqual([0, 1]);
    expect(all[0]?.text).toBe('So the sync is the bottleneck.');
    expect(all[1]?.text).toBe('And now we are back.');

    // One meeting, not two: the index folded the resume into the record it
    // already had, and the resume undid the end the shutdown wrote.
    const records = listMeetings(dataDir, canonical);
    expect(records).toHaveLength(1);
    expect(records[0]?.meetingId).toBe(meetingId);
    expect(records[0]?.resumedAt).toHaveLength(1);
    expect(records[0]?.endedAt).not.toBeNull();
    expect(records[0]?.turns).toBe(2);

    // One notes section for one meeting: the heading store is keyed by
    // meeting id, so a resumed meeting can only ever address the section it
    // opened. Nothing else may have appeared beside it.
    const sections = readdirSync(meetingDirPath(dataDir, canonical)).filter((f) =>
      f.endsWith('-section.json'),
    );
    expect(sections.length).toBeLessThanOrEqual(1);
    for (const file of sections) {
      expect(join(meetingDirPath(dataDir, canonical), file)).toBe(
        meetingSectionPath(dataDir, canonical, meetingId),
      );
    }

    // And the record a person reads keeps BOTH halves: the segment written at
    // the shutdown, and the continuation the resumed leg added under the same
    // segment number rather than as a second recording.
    const raw = readFileSync(
      join(meetingDirPath(dataDir, canonical), 'resume-me-raw-transcript.md'),
      'utf8',
    );
    expect(raw).toContain('## Segment 1 —');
    expect(raw).toContain('## Segment 1 (resumed) —');
    expect(raw).toContain('So the sync is the bottleneck.');
    expect(raw).toContain('And now we are back.');
    expect(raw).not.toContain('## Segment 2');
  });

  it('opens a new meeting when the one asked for is gone, and says it did', async () => {
    const { first, ws, canonical } = await seed('resume-nothing');
    const client = await AudioClient.open(first.port, ws, 'resume-nothing');
    // An id shaped exactly like a real one, for a meeting this doc never held.
    client.start({ resume: `m-${canonical}-1` });
    const ready = await client.waitFrame('ready');
    expect(ready.resumed).toBeUndefined();
    expect(ready.meetingId).not.toBe(`m-${canonical}-1`);
    // A fresh meeting numbers from zero, because nothing is above it.
    client.speak(7);
    await waitFor(() => client.finals().length === 1, { describe: 'a settled turn' });
    expect(client.finals()[0]?.turn).toBe(0);
    client.stop();
    await client.waitFrame('stopped');
    client.ws.close();
    // The refused id left nothing behind — no transcript file was conjured
    // under a name the client made up.
    expect(existsSync(meetingTranscriptPath(dataDir, canonical, `m-${canonical}-1`))).toBe(false);
    expect(listMeetings(dataDir, canonical)).toHaveLength(1);
  });

  it('refuses to resume a meeting another socket is already holding', async () => {
    const { first, ws } = await seed('resume-busy');
    const holder = await AudioClient.open(first.port, ws, 'resume-busy');
    holder.start();
    const ready = await holder.waitFrame('ready');

    const second = await AudioClient.open(first.port, ws, 'resume-busy');
    second.start({ resume: String(ready.meetingId) });
    const refusal = await second.waitFrame('unavailable');
    // The lock is the doc's, and a resume does not pick it. The client's own
    // backoff is what turns this into another attempt a second later.
    expect(refusal.reason).toBe('already_recording');
    second.ws.close();

    holder.stop();
    await holder.waitFrame('stopped');
    holder.ws.close();
  });
});
