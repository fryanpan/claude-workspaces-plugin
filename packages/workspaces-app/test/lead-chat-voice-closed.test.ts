/**
 * The voice socket closes while the page stays: voice stops with CLOSED, and
 * the report names how it closed — the close code, the reason, whether it was
 * clean, and how long after it opened. Without them a drop cannot say whether
 * the server hung up (a code and a reason) or the path went away (1006, not
 * clean). The socket and the microphone are fakes; the clock is vitest's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LeadVoice, createLeadVoice } from '../src/lead-chat/lead-chat-voice.ts';
import { fakeVoice } from './lead-chat-voice-fakes.ts';

describe('a voice socket that closes by itself', () => {
  let voice: LeadVoice | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    voice?.destroy();
    voice = null;
    vi.useRealTimers();
  });

  async function listening() {
    const fake = fakeVoice();
    const reports: Error[] = [];
    voice = createLeadVoice({
      ...fake.seams,
      report: (e) => reports.push(e),
      workspaceId: 'w-harbor',
      author: { id: 'known-first-person', name: 'Alice', kind: 'known' },
      getContext: () => ({ surface: 'board' }),
      agent: () => 'house-lead',
      onChange: () => {},
    });
    voice.start();
    await vi.advanceTimersByTimeAsync(0);
    /** `ms` pass with the reader talking, so no silent-mic stop gets in first. */
    const talkFor = async (ms: number): Promise<void> => {
      for (let t = 0; t < ms; t += 500) {
        fake.speak();
        await vi.advanceTimersByTimeAsync(500);
      }
    };
    return { fake, reports, voice, ws: fake.socket(), talkFor };
  }

  const stopped = (reports: Error[]) => reports.filter((e) => e.name === 'LeadVoiceStopped');

  it('reports the close code, reason, wasClean and seconds since the socket opened', async () => {
    const { reports, voice, ws, talkFor } = await listening();
    ws.open();
    await talkFor(77_000);
    ws.onclose?.({ code: 1006, reason: '', wasClean: false });
    expect(voice.state().phase).toBe('off');
    const [err] = stopped(reports);
    expect(err?.message).toContain('The connection closed.');
    expect(err?.message).toContain('code 1006');
    expect(err?.message).toContain('reason none');
    expect(err?.message).toContain('wasClean false');
    expect(err?.message).toContain('77s after it opened');
  });

  it('carries the reason a server close gave', async () => {
    const { reports, ws, talkFor } = await listening();
    ws.open();
    await talkFor(3_000);
    ws.onclose?.({ code: 1008, reason: 'widget token ended', wasClean: true });
    const [err] = stopped(reports);
    expect(err?.message).toContain('code 1008');
    expect(err?.message).toContain('reason "widget token ended"');
    expect(err?.message).toContain('wasClean true');
    expect(err?.message).toContain('3s after it opened');
  });

  it('says a socket that never opened never did', async () => {
    const { reports, ws, talkFor } = await listening();
    await talkFor(10_000);
    ws.onclose?.({ code: 1006, reason: '', wasClean: false });
    const [err] = stopped(reports);
    expect(err?.message).toContain('code 1006');
    expect(err?.message).toContain('before it opened, 10s after it was made');
  });
});
