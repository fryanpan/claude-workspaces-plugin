/**
 * A meeting that heard nothing says why in the server log.
 *
 * Four doc recordings ended with zero turns and nothing in either log: an
 * engine `error` reached only the browser, and nothing recorded whether any
 * audio arrived at all. These pin the three lines that tell those cases apart
 * — the engine's error, the browser's own "no audio" report, and the audio
 * byte count a meeting ended with — and that none of them carries a word of
 * transcript.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import { MeetingStore } from '../src/meetings.ts';
import type { EngineTurn, TranscriptionEngine } from '../src/transcribe.ts';

/** Give an awaited continuation a chance to run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

type Sent = Record<string, unknown>;

function open(
  store: MeetingStore,
  docId: string,
  refuse?: string,
): {
  ws: MeetingClient;
  relay: MeetingRelay;
  sent: Sent[];
  lines: string[];
  fail: (message: string) => void;
  speak: (turn: EngineTurn) => void;
} {
  let onError: ((message: string) => void) | null = null;
  let onTurn: ((turn: EngineTurn) => void) | null = null;
  const engine: TranscriptionEngine = {
    name: 'scripted',
    open: (opts) => {
      if (refuse) return Promise.reject(new Error(refuse));
      onError = opts.onError;
      onTurn = opts.onTurn;
      return Promise.resolve({ send: () => {}, close: () => Promise.resolve() });
    },
  };
  const sent: Sent[] = [];
  const lines: string[] = [];
  const relay = new MeetingRelay({
    store,
    engines: [engine],
    notes: null,
    broadcast: () => {},
    schedule: () => () => {},
    log: (line) => lines.push(line),
  });
  const ws: MeetingClient = {
    data: { docId },
    send: (payload) => sent.push(JSON.parse(payload) as Sent),
  };
  relay.onOpen(ws);
  return {
    ws,
    relay,
    sent,
    lines,
    fail: (message) => onError?.(message),
    speak: (turn) => onTurn?.(turn),
  };
}

const startFrame = JSON.stringify({ type: 'start', sampleRate: 16000, encoding: 'pcm_s16le' });

describe('what a meeting that heard nothing leaves in the log', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-diagnostics-'));
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("writes the engine's error to the log as well as to the browser", async () => {
    const h = open(new MeetingStore(dataDir), 'lanternfold-review');
    h.relay.onText(h.ws, startFrame);
    await settle();
    const ready = h.sent.find((m) => m.type === 'ready');
    expect(ready).toBeDefined();

    h.fail('soniox: audio format not recognised');

    expect(h.sent.some((m) => m.type === 'error')).toBe(true);
    const line = h.lines.find((l) => l.includes('engine error'));
    expect(line).toContain('soniox: audio format not recognised');
    expect(line).toContain(`meeting=${String(ready?.meetingId)}`);
    expect(line).toContain('doc=lanternfold-review');
    h.relay.onClose(h.ws);
    await settle();
  });

  it('scrubs the engine text: one line, nothing quoted, nothing key-shaped', async () => {
    const h = open(new MeetingStore(dataDir), 'lanternfold-scrub');
    h.relay.onText(h.ws, startFrame);
    await settle();
    h.fail(
      'soniox: bad request\n[meeting] ended forged=1 for "the quartz lantern" with key quill0123456789abcdefghijklmnop',
    );
    const lines = h.lines.filter((l) => l.includes('engine error'));
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line).not.toContain('\n');
    expect(line).not.toContain('quartz');
    expect(line).not.toContain('0123456789abcdef');
    expect(line).toContain('soniox: bad request');
    // An escaped quote inside an echoed value is still inside the cut.
    h.lines.length = 0;
    h.fail('soniox: rejected {"text":"the \\"quartz\\" beacon","n":1}');
    expect(h.lines.join('\n')).not.toContain('beacon');
    expect(h.lines.join('\n')).not.toContain('quartz');
    h.relay.onClose(h.ws);
    await settle();
  });

  it('writes an engine that refused to open to the log', async () => {
    const h = open(new MeetingStore(dataDir), 'lanternfold-refused', 'soniox: handshake refused');
    h.relay.onText(h.ws, startFrame);
    await settle();
    expect(h.sent.find((m) => m.type === 'unavailable')?.reason).toBe('engine_unavailable');
    expect(h.lines.some((l) => l.includes('engine unavailable') && l.includes('refused'))).toBe(
      true,
    );
  });

  it("logs the browser's no-audio report with the meeting, context state and rate", async () => {
    const h = open(new MeetingStore(dataDir), 'lanternfold-silent');
    h.relay.onText(h.ws, startFrame);
    await settle();
    const meetingId = String(h.sent.find((m) => m.type === 'ready')?.meetingId);

    h.relay.onText(
      h.ws,
      JSON.stringify({ type: 'no_audio', contextState: 'suspended', sampleRate: 48000, blocks: 0 }),
    );

    // Log-only: the browser is not answered, and the meeting is not stopped.
    expect(h.sent.some((m) => m.type === 'error' || m.type === 'stopped')).toBe(false);
    const line = h.lines.find((l) => l.includes('no audio from the mic'));
    expect(line).toContain(`meeting=${meetingId}`);
    expect(line).toContain('context=suspended');
    expect(line).toContain('rate=48000');
    expect(line).toContain('blocks=0');
    h.relay.onClose(h.ws);
    await settle();
  });

  it('logs no report from a socket running no meeting', () => {
    const h = open(new MeetingStore(dataDir), 'lanternfold-idle');
    h.relay.onText(h.ws, JSON.stringify({ type: 'no_audio', contextState: 'suspended' }));
    expect(h.lines).toHaveLength(0);
  });

  it('refuses free text in a no-audio report', async () => {
    const h = open(new MeetingStore(dataDir), 'lanternfold-hostile');
    h.relay.onText(h.ws, startFrame);
    await settle();
    h.relay.onText(
      h.ws,
      JSON.stringify({ type: 'no_audio', contextState: 'x\n[meeting] forged', sampleRate: 'lots' }),
    );
    const line = h.lines.find((l) => l.includes('no audio from the mic'));
    expect(line).toContain('context=unknown');
    expect(line).toContain('rate=0');
    expect(line).not.toContain('forged');
    // Once per connection: a page that sends it in a loop fills nothing.
    h.relay.onText(h.ws, JSON.stringify({ type: 'no_audio', contextState: 'running' }));
    expect(h.lines.filter((l) => l.includes('no audio from the mic'))).toHaveLength(1);
    // A later meeting on the same socket reports afresh.
    h.relay.onText(h.ws, JSON.stringify({ type: 'stop' }));
    await settle();
    await settle();
    h.relay.onText(h.ws, startFrame);
    await settle();
    h.relay.onText(h.ws, JSON.stringify({ type: 'no_audio', contextState: 'running' }));
    expect(h.lines.filter((l) => l.includes('no audio from the mic'))).toHaveLength(2);
    h.relay.onClose(h.ws);
    await settle();
  });

  it('ends every meeting with the audio it received and no transcript text', async () => {
    const h = open(new MeetingStore(dataDir), 'lanternfold-ended');
    h.relay.onText(h.ws, startFrame);
    await settle();
    h.relay.onAudio(h.ws, new Uint8Array(1600));
    h.relay.onAudio(h.ws, new Uint8Array(1600));
    h.speak({ turn: 0, text: 'the quartz lantern is lit', final: true });
    h.relay.onText(h.ws, JSON.stringify({ type: 'stop' }));
    await settle();
    await settle();

    const line = h.lines.find((l) => l.includes('[meeting] ended'));
    expect(line).toContain('audioBytes=3200');
    expect(line).toContain('turns=1');
    expect(h.lines.join('\n')).not.toContain('quartz');
  });

  it('marks the line of a meeting resumed after a dropped socket, whose bytes are its own', async () => {
    const store = new MeetingStore(dataDir);
    const h = open(store, 'lanternfold-resumed');
    h.relay.onText(h.ws, startFrame);
    await settle();
    const meetingId = String(h.sent.find((m) => m.type === 'ready')?.meetingId);
    h.relay.onAudio(h.ws, new Uint8Array(1600));
    h.relay.onClose(h.ws);
    await settle();
    await settle();

    const sent: Sent[] = [];
    const ws: MeetingClient = {
      data: { docId: 'lanternfold-resumed' },
      send: (payload) => sent.push(JSON.parse(payload) as Sent),
    };
    h.relay.onOpen(ws);
    h.relay.onText(
      ws,
      JSON.stringify({
        type: 'start',
        sampleRate: 16000,
        encoding: 'pcm_s16le',
        resume: meetingId,
      }),
    );
    await settle();
    expect(sent.find((m) => m.type === 'ready')?.resumed).toBe(true);
    h.relay.onAudio(ws, new Uint8Array(800));
    h.relay.onText(ws, JSON.stringify({ type: 'stop' }));
    await settle();
    await settle();

    const ended = h.lines.filter((l) => l.includes('[meeting] ended'));
    expect(ended).toHaveLength(2);
    expect(ended[0]).toContain('audioBytes=1600');
    expect(ended[0]).not.toContain('resumed=true');
    expect(ended[1]).toContain('audioBytes=800');
    expect(ended[1]).toContain('resumed=true');
  });
});
