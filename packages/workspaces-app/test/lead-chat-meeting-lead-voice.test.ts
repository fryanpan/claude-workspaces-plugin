/**
 * What the board's lead says into a meeting, on a page
 * (`lead-chat-meeting-wiring.ts` through `mountLeadChat`): the tab that holds
 * the microphone of a microphone meeting fetches the line voiced and marks it
 * played; a Mac-audio meeting only shows it, because that recording takes in
 * whatever the machine plays with no echo cancellation; and a line played in
 * one meeting is not marked played in the next one that reuses its turn.
 * Client, socket, microphone and the voice fetch are fakes; no audio plays
 * (the player is given no audio context).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { leadLinePlaysHere } from '../src/lead-chat/lead-chat-meeting-voice.ts';
import { type LeadChatMount, mountLeadChat } from '../src/lead-chat/lead-chat-mount.ts';
import {
  ALICE,
  fakeClock,
  fakeMeetingClient,
  fakeMic,
  fakeSockets,
  flush,
  meetingFixture,
} from './lead-chat-meeting-fakes.ts';
import { fakeVoice } from './lead-chat-voice-fakes.ts';

const REC_KEY = 'cw.lead-chat.recorder';

let mounted: LeadChatMount | null = null;
afterEach(() => {
  mounted?.destroy();
  mounted = null;
  document.body.innerHTML = '';
});

function mount(meeting: ReturnType<typeof meetingFixture>) {
  const fake = fakeMeetingClient(meeting);
  const clock = fakeClock();
  const voiced: Array<{ id: string; turn: number }> = [];
  const session = new Map([[REC_KEY, 'rec-here']]);
  mounted = mountLeadChat({
    workspaceId: 'w-harbor',
    author: ALICE,
    getContext: () => ({ surface: 'doc', docId: 'd-saltmarsh' }),
    client: fake.client,
    storage: null,
    session: {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k),
    },
    voice: fakeVoice().seams,
    reducedMotion: () => true,
    meeting: {
      openSocket: fakeSockets().openSocket,
      startCapture: fakeMic().startCapture,
      createAudioContext: () => ({}) as AudioContext,
      now: clock.now,
      schedule: clock.schedule,
      loadDocs: async () => [],
      newDoc: async () => null,
      macAudio: true,
      today: new Date(2026, 9, 31),
      leadVoice: {
        playbackContext: () => null,
        fetch: (async (_url: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { id: string; turn: number };
          voiced.push({ id: body.id, turn: body.turn });
          return new Response(new Uint8Array([1, 0, 2, 0]), {
            headers: { 'x-sample-rate': '24000' },
          });
        }) as typeof fetch,
      },
    },
  });
  const rows = () =>
    [...(mounted?.view.root.querySelectorAll<HTMLElement>('.lc-line[data-lead="1"]') ?? [])].map(
      (r) => ({ text: r.textContent ?? '', said: r.dataset.said ?? '' }),
    );
  mounted.view.button.click();
  return { ...fake, voiced, rows };
}

describe('the lead’s line on a page', () => {
  it('plays only on the recording tab of a microphone meeting', () => {
    expect(leadLinePlaysHere({ recorder: 'rec-here', source: 'mic' }, 'rec-here')).toBe(true);
    expect(leadLinePlaysHere({ recorder: 'rec-here', source: 'mix' }, 'rec-here')).toBe(false);
    expect(leadLinePlaysHere({ recorder: 'rec-here', source: 'bot' }, 'rec-here')).toBe(false);
    expect(leadLinePlaysHere({ recorder: 'rec-other', source: 'mic' }, 'rec-here')).toBe(false);
  });

  it('fetches the line voiced and marks it played, in a microphone meeting', async () => {
    const t = mount(meetingFixture({ source: 'mic' }));
    t.leadLine('lcm-1', 0.5, 'Who is the slipway for?');
    await vi.waitFor(() => expect(t.rows()[0]?.said).toBe('said'));
    expect(t.voiced).toEqual([{ id: 'lcm-1', turn: 0.5 }]);
  });

  it('only shows the line in a Mac-audio meeting, which would record it back', async () => {
    const t = mount(meetingFixture({ source: 'mix' }));
    t.leadLine('lcm-1', 0.5, 'Who is the slipway for?');
    await vi.waitFor(() => expect(t.rows()[0]?.text).toContain('Who is the slipway for?'));
    await flush();
    expect(t.voiced).toEqual([]);
    expect(t.rows()[0]?.said).toBe('');
  });

  it('does not mark a line played because the last meeting played its turn', async () => {
    const t = mount(meetingFixture({ id: 'lcm-1', source: 'mic' }));
    t.leadLine('lcm-1', 0.5, 'First meeting.');
    await vi.waitFor(() => expect(t.rows()[0]?.said).toBe('said'));
    // The next meeting, on another device's tab: same turn, never played here.
    t.setMeeting(meetingFixture({ id: 'lcm-2', source: 'mic', recorder: 'rec-other' }));
    t.leadLine('lcm-2', 0.5, 'Second meeting.');
    await vi.waitFor(() => expect(t.rows()[0]?.text).toContain('Second meeting.'));
    expect(t.rows()[0]?.said).toBe('');
    expect(t.voiced).toEqual([{ id: 'lcm-1', turn: 0.5 }]);
  });
});
