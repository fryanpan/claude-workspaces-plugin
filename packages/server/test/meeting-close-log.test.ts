/**
 * Why a meeting socket closed, in the log.
 *
 * A real meeting dropped its socket five times and nothing on the server said
 * why any of them went. Diagnosing the run needed an investigation before the
 * investigation could start: the only line a closing meeting wrote was
 * `[meeting] ended`, which reads identically for a person pressing Stop, a tab
 * closing, and a network that went away mid-sentence.
 *
 * So this file closes a socket for each reason the server can actually SEE —
 * the client asking to stop, the server's own silence deadline, and every
 * close code a transport can hand us — and reads the cause back off the log.
 * It asserts the cause word, never the whole line, because the line's other
 * fields are counts that move.
 *
 * All fixtures are synthetic; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MeetingClient, MeetingRelay, meetingCloseCause } from '../src/meeting-protocol.ts';
import { MeetingStore } from '../src/meetings.ts';
import type { TranscriptionEngine } from '../src/transcribe.ts';

/** An engine that opens at once and hears everything. */
function mockEngine(): TranscriptionEngine {
  return {
    name: 'mock',
    open: () => Promise.resolve({ send: () => {}, close: () => Promise.resolve() }),
  };
}

function createClient(docId: string): MeetingClient {
  return { data: { docId }, send() {} };
}

/** Give the awaited handshake continuation a chance to run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The `cause=` field of the newest `socket closed` line, or null. */
function causeOf(lines: string[]): string | null {
  const line = [...lines].reverse().find((l) => l.includes('socket closed'));
  return line?.match(/cause=(\S+)/)?.[1] ?? null;
}

describe('why a meeting socket closed', () => {
  let dataDir: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-close-log-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A relay with a live meeting on a fresh doc, and the log it writes to. */
  async function liveMeeting(docId: string, opts: { schedule?: MeetingRelayDepsSchedule } = {}) {
    const lines: string[] = [];
    const relay = new MeetingRelay({
      store: new MeetingStore(dataDir),
      engines: [mockEngine()],
      notes: null,
      broadcast: () => {},
      log: (line) => lines.push(line),
      ...(opts.schedule ? { schedule: opts.schedule } : {}),
    });
    const ws = createClient(docId);
    relay.onOpen(ws);
    relay.onText(ws, JSON.stringify({ type: 'start', sampleRate: 16000, encoding: 'pcm_s16le' }));
    await settle();
    return { relay, ws, lines };
  }

  type MeetingRelayDepsSchedule = (ms: number, fn: () => void) => () => void;

  it('names the close code the transport reported', async () => {
    // Every code a browser or a proxy can hand this server, and the word the
    // log gives it. 1006 is the one this whole file exists for: no close
    // frame at all, which is what a network that went away looks like.
    const cases: Array<[number | undefined, string]> = [
      [1000, 'clean-close'],
      [1001, 'tab-closed'],
      [1002, 'protocol-error'],
      [1005, 'no-status'],
      [1006, 'network-drop'],
      [1008, 'policy'],
      [1009, 'too-big'],
      [1011, 'server-error'],
      [1012, 'server-restart'],
      [1013, 'try-again'],
      [undefined, 'unknown'],
      [4321, 'code-4321'],
    ];
    for (const [code, want] of cases) {
      const { relay, ws, lines } = await liveMeeting(`close-code-${code ?? 'none'}`);
      relay.onClose(ws, code);
      await settle();
      expect(causeOf(lines)).toBe(want);
    }
  });

  it('says the person asked, when the close follows a stop frame', async () => {
    const { relay, ws, lines } = await liveMeeting('close-client-stop');
    relay.onText(ws, JSON.stringify({ type: 'stop' }));
    await settle();
    // The browser closes the socket right after; a 1000 here is still the
    // person's Stop, not a connection that happened to end tidily.
    relay.onClose(ws, 1000);
    await settle();
    expect(causeOf(lines)).toBe('client-stop');
  });

  it('says the server timed the room out, when the silence deadline fired', async () => {
    let fire: (() => void) | null = null;
    const { relay, ws, lines } = await liveMeeting('close-silence', {
      schedule: (_ms, fn) => {
        fire = fn;
        return () => {};
      },
    });
    expect(fire).not.toBeNull();
    (fire as unknown as () => void)();
    await settle();
    relay.onClose(ws, 1000);
    await settle();
    expect(causeOf(lines)).toBe('silence');
  });

  it('carries the peer reason text, scrubbed', async () => {
    const { relay, ws, lines } = await liveMeeting('close-detail');
    relay.onClose(ws, 1006, 'upstream went away');
    await settle();
    const line = [...lines].reverse().find((l) => l.includes('socket closed')) ?? '';
    expect(line).toContain('detail=upstream went away');
  });

  it('names the doc and the meeting a closed socket was carrying', async () => {
    const { relay, ws, lines } = await liveMeeting('close-ids');
    relay.onClose(ws, 1006);
    await settle();
    const line = [...lines].reverse().find((l) => l.includes('socket closed')) ?? '';
    expect(line).toContain('doc=close-ids');
    expect(line).toMatch(/meeting=m-close-ids-\d+/);
    expect(line).toContain('recording=yes');
  });

  it('classifies a code with no meeting behind it too', () => {
    // The pure half, so the table above is a claim about this function rather
    // than about how many sockets a test could afford to open.
    expect(meetingCloseCause(1006)).toBe('network-drop');
    expect(meetingCloseCause(undefined)).toBe('unknown');
    expect(meetingCloseCause(4999)).toBe('code-4999');
  });
});
