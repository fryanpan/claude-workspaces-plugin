/**
 * One voice, one name, however many engine sessions the conversation took.
 *
 * A diarization label belongs to an engine SESSION — every session hands out
 * "A" again — while the name a person types belongs to the people in the
 * room. Kept per meeting, a name given once covered one leg: the socket
 * dropped, or the person stopped and started the recording, and everything
 * downstream saw a brand-new unnamed voice. This file drives the real audio
 * socket across both of those boundaries and asserts what the doc ends up
 * knowing about its cast.
 *
 * All fixtures are synthetic, and the names in them are invented. The repo is
 * public.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  meetingSocketPath,
} from '@claude-workspaces/core';
import { docSpeakerNames, listMeetings, readTranscript } from '../src/meetings.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type MockScriptTurn, createMockTranscriptionEngine } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

// A socket round trip on a loaded machine has been measured in seconds, and
// every wait below is a poll — a healthy run pays none of this.
setDefaultTimeout(30_000);

interface ServerFrame {
  type: string;
  [key: string]: unknown;
}

/** Two voices, so a test can tell a carried name from a blanket one. */
const SCRIPT: readonly MockScriptTurn[] = [
  { words: ['the', 'room', 'is', 'ready'], settled: 'The room is ready.', speaker: 'A' },
  { words: ['so', 'is', 'the', 'agenda'], settled: 'So is the agenda.', speaker: 'B' },
];

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

  /** `conversation`, because that is the only capture that labels voices. */
  start(extra: Record<string, unknown> = {}): void {
    this.ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
        mode: 'conversation',
        ...extra,
      }),
    );
  }

  name(speaker: string, name: string): void {
    this.ws.send(JSON.stringify({ type: 'name_speaker', speaker, name }));
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

  /** Settled turns and the label each carried, in arrival order. */
  finals(): Array<{ turn: number; speaker?: string }> {
    return this.frames
      .filter((f) => f.type === 'transcript' && f.final === true)
      .map((f) => ({ turn: f.turn as number, speaker: f.speaker as string | undefined }));
  }
}

describe('a voice keeps its name across every engine session of a doc', () => {
  let dataDir = '';
  const running: ServerHandle[] = [];

  const boot = (): { handle: ServerHandle; base: string; port: number } => {
    const handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine(SCRIPT),
    });
    running.push(handle);
    return { handle, base: `http://127.0.0.1:${handle.port}`, port: handle.port };
  };

  afterEach(async () => {
    for (const handle of running.splice(0)) await handle.stop().catch(() => undefined);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
  });

  const seed = async (docId: string) => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-speaker-continuity-'));
    const server = boot();
    const ws = await seedBoard(server.base);
    const path = join(dataDir, `${docId}.md`);
    writeFileSync(path, `# ${docId}\n\nNotes go here.\n`);
    const res = await fetch(`${server.base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, sourceUrl: path, title: docId }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const canonical = ((await res.json()) as { docId: string }).docId;
    return { server, ws, canonical };
  };

  /**
   * Labels that spoke somewhere on this doc and that nothing on the doc has a
   * name for — the count the 15 September meeting's 87 bullets were pointing
   * at. The whole point of the fix is that it stays empty.
   */
  const unnamedVoices = (docId: string): string[] => {
    const named = docSpeakerNames(dataDir, docId);
    const heard = new Set<string>();
    for (const record of listMeetings(dataDir, docId)) {
      for (const turn of readTranscript(dataDir, docId, record.meetingId)) {
        if (turn.speaker !== undefined) heard.add(turn.speaker);
      }
    }
    return [...heard].filter((label) => named[label] === undefined).sort();
  };

  it('a reconnect resumes into the cast the person already named', async () => {
    const { server, ws, canonical } = await seed('reconnect-cast');

    const first = await AudioClient.open(server.port, ws, 'reconnect-cast');
    first.start();
    const ready = await first.waitFrame('ready');
    const meetingId = String(ready.meetingId);
    // Nothing named yet, so the frame says nothing about a cast.
    expect(ready.speakers).toBeUndefined();

    // Five chunks reveal and settle the first turn of the script.
    first.speak(5);
    await waitFor(() => first.finals().length === 1, { describe: 'the first turn to settle' });
    expect(first.finals()[0]?.speaker).toBe('A');
    first.name('A', 'Riverbend');
    await waitFor(() => listMeetings(dataDir, canonical)[0]?.speakers?.A === 'Riverbend', {
      describe: 'the name to reach the record',
    });

    // The drop: the socket goes away without a stop, which is what a network
    // blip looks like to this server.
    first.ws.close();
    await waitFor(() => listMeetings(dataDir, canonical)[0]?.endedAt !== null, {
      describe: 'the dropped socket to end the leg',
    });

    const back = await AudioClient.open(server.port, ws, 'reconnect-cast');
    back.start({ resume: meetingId });
    const resumed = await back.waitFrame('ready');
    expect(resumed.resumed).toBe(true);
    // The answer carries the cast, so the strip does not have to remember it
    // — and cannot be the only thing that does.
    expect(resumed.speakers).toEqual({ A: 'Riverbend' });

    // The resumed leg's engine session numbers and labels from scratch: its
    // "A" is the voice the person already named, and nothing on this doc is
    // left pointing at a nameless label.
    back.speak(5);
    await waitFor(() => back.finals().length === 1, { describe: 'the resumed turn to settle' });
    expect(back.finals()[0]?.speaker).toBe('A');
    back.stop();
    await back.waitFrame('stopped');
    back.ws.close();

    expect(unnamedVoices(canonical)).toEqual([]);
    expect(docSpeakerNames(dataDir, canonical)).toEqual({ A: 'Riverbend' });
  });

  it('a stop and a fresh recording keep the same set of speakers', async () => {
    const { server, ws, canonical } = await seed('restart-cast');

    const first = await AudioClient.open(server.port, ws, 'restart-cast');
    first.start();
    await first.waitFrame('ready');
    // Ten chunks carry both turns of the script, so both voices are heard.
    first.speak(10);
    await waitFor(() => first.finals().length === 2, { describe: 'both turns to settle' });
    first.name('A', 'Riverbend');
    first.name('B', 'Harborlight');
    await waitFor(() => Object.keys(docSpeakerNames(dataDir, canonical)).length === 2, {
      describe: 'both names to reach the doc',
    });
    first.stop();
    await first.waitFrame('stopped');
    first.ws.close();

    // A NEW recording: its own meeting id, its own transcript, its own notes
    // section — and the same two people at the table.
    const second = await AudioClient.open(server.port, ws, 'restart-cast');
    second.start();
    const ready = await second.waitFrame('ready');
    expect(ready.resumed).toBeUndefined();
    expect(ready.speakers).toEqual({ A: 'Riverbend', B: 'Harborlight' });

    second.speak(10);
    await waitFor(() => second.finals().length === 2, { describe: 'both turns of the second' });
    second.stop();
    await second.waitFrame('stopped');
    second.ws.close();

    const records = listMeetings(dataDir, canonical);
    expect(records).toHaveLength(2);
    // The second meeting's own record says who spoke in it — written when the
    // voice actually spoke, so a record never claims a speaker it never heard.
    expect(records[1]?.speakers).toEqual({ A: 'Riverbend', B: 'Harborlight' });
    expect(unnamedVoices(canonical)).toEqual([]);
  });

  it('a record only claims the carried voices that actually spoke', async () => {
    const { server, ws, canonical } = await seed('one-voice');

    const first = await AudioClient.open(server.port, ws, 'one-voice');
    first.start();
    await first.waitFrame('ready');
    first.speak(10);
    await waitFor(() => first.finals().length === 2, { describe: 'both turns to settle' });
    first.name('A', 'Riverbend');
    first.name('B', 'Harborlight');
    await waitFor(() => Object.keys(docSpeakerNames(dataDir, canonical)).length === 2, {
      describe: 'both names to reach the doc',
    });
    first.stop();
    await first.waitFrame('stopped');
    first.ws.close();

    // Only the first voice speaks this time, so only that one is written into
    // the second meeting's cast: the roster a reader is offered is the one
    // this meeting actually heard, not the doc's whole history.
    const second = await AudioClient.open(server.port, ws, 'one-voice');
    second.start();
    await second.waitFrame('ready');
    second.speak(5);
    await waitFor(() => second.finals().length === 1, { describe: 'the one turn to settle' });
    second.stop();
    await second.waitFrame('stopped');
    second.ws.close();

    expect(listMeetings(dataDir, canonical)[1]?.speakers).toEqual({ A: 'Riverbend' });
  });
});
