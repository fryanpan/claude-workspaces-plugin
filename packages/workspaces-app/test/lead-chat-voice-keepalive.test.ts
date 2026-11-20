/**
 * The server's keepalive frame reaches a listening lead chat: nothing
 * changes. The voice stays on, nothing is reported, and the page sends
 * nothing back. The socket and the microphone are fakes; the clock is
 * vitest's.
 */
import { SPOKEN_KEEPALIVE_FRAME } from '@claude-workspaces/core/spoken-reply';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LeadVoice, createLeadVoice } from '../src/lead-chat/lead-chat-voice.ts';
import { fakeVoice } from './lead-chat-voice-fakes.ts';

describe('a keepalive frame on the lead chat voice socket', () => {
  let voice: LeadVoice | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    voice?.destroy();
    voice = null;
    vi.useRealTimers();
  });

  it('is dropped without a report, a state change or a reply', async () => {
    const fake = fakeVoice();
    const reports: Error[] = [];
    let changes = 0;
    voice = createLeadVoice({
      ...fake.seams,
      report: (e) => reports.push(e),
      workspaceId: 'w-harbor',
      author: { id: 'known-first-person', name: 'Alice', kind: 'known' },
      getContext: () => ({ surface: 'board' }),
      agent: () => 'house-lead',
      onChange: () => {
        changes++;
      },
    });
    voice.start();
    await vi.advanceTimersByTimeAsync(0);
    const ws = fake.socket();
    ws.open();
    await vi.advanceTimersByTimeAsync(0);
    const before = { phase: voice.state().phase, changes, sent: ws.messages().length };
    for (let i = 0; i < 3; i++) ws.onmessage?.({ data: SPOKEN_KEEPALIVE_FRAME });
    await vi.advanceTimersByTimeAsync(0);
    expect(voice.state().phase).toBe(before.phase);
    expect(changes).toBe(before.changes);
    expect(ws.messages().length).toBe(before.sent);
    expect(reports).toEqual([]);
  });
});
