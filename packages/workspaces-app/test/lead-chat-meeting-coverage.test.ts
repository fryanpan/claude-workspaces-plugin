/**
 * The lead chat's meeting says whether it is recording and how many minutes
 * it has captured, and raises an alert when no audio has arrived for over a
 * minute — on a page that is already open, from a change the server made
 * (`setMeeting` is the board-stream frame). A meeting once lost two thirds of
 * its audio with nothing on screen; this is the screen.
 *
 * Client and socket are fakes (`lead-chat-meeting-fakes.ts`).
 */
import { COVERAGE_GAP_MS, type MeetingCoverageLive, localClock } from '@claude-workspaces/core';
import type { LeadChatMeeting } from '@claude-workspaces/core/lead-chat';
import { afterEach, describe, expect, it } from 'vitest';
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

let mounted: LeadChatMount | null = null;
afterEach(() => {
  mounted?.destroy();
  mounted = null;
  document.body.innerHTML = '';
});

function mount(meeting: LeadChatMeeting) {
  const fake = fakeMeetingClient(meeting);
  const clock = fakeClock();
  mounted = mountLeadChat({
    workspaceId: 'w-harbor',
    author: ALICE,
    getContext: () => ({ surface: 'board' }),
    client: fake.client,
    storage: null,
    session: null,
    voice: fakeVoice().seams,
    reducedMotion: () => true,
    meeting: {
      openSocket: fakeSockets().openSocket,
      startCapture: fakeMic().startCapture,
      createAudioContext: () => ({}) as AudioContext,
      now: clock.now,
      schedule: clock.schedule,
      loadDocs: async () => [{ docId: 'd-saltmarsh', title: 'Saltmarsh notes' }],
      newDoc: async () => 'd-new',
      macAudio: false,
      today: new Date(2026, 10, 17),
    },
  });
  return { ...fake, view: mounted.view };
}

const MIN = 60_000;

/** Twelve minutes in, every one of them heard. */
function heard(over: Partial<MeetingCoverageLive> = {}): MeetingCoverageLive {
  const now = Date.now();
  return {
    meetingId: 'm-saltmarsh',
    startedAt: now - 12 * MIN,
    capturedMs: 12 * MIN,
    asOf: now,
    state: 'recording',
    gapsClosed: 0,
    ...over,
  };
}

const status = (view: LeadChatMount['view']) =>
  view.meeting.head.querySelector<HTMLElement>('.lc-meet-status');
const alert = (view: LeadChatMount['view']) =>
  view.meeting.notes.querySelector<HTMLElement>('.lc-alert');

describe('a meeting’s recording status in the lead chat', () => {
  it('says it is recording and how many minutes it has captured', async () => {
    const t = mount(meetingFixture({ recorder: 'rec-elsewhere', coverage: heard() }));
    await flush();
    t.view.button.click();
    expect(status(t.view)?.textContent).toBe('Recording · 12 min');
    expect(alert(t.view)?.hidden).toBe(true);
  });

  it('raises the alert on an open page when the audio stops, and clears it when it returns', async () => {
    const base = meetingFixture({ recorder: 'rec-elsewhere', coverage: heard() });
    const t = mount(base);
    await flush();
    t.view.button.click();
    const head = t.view.meeting.head;
    const from = Date.now() - COVERAGE_GAP_MS - 5_000;
    t.setMeeting({
      ...base,
      coverage: heard({ state: 'gap', capturedMs: 11 * MIN, gap: { from, reason: 'no-audio' } }),
    });
    // The same elements, changed in place.
    expect(t.view.meeting.head).toBe(head);
    expect(status(t.view)?.textContent).toBe('No audio · 11 of 12 min');
    expect(alert(t.view)?.hidden).toBe(false);
    expect(alert(t.view)?.textContent).toBe(
      `No audio has reached the meeting since ${localClock(from)}. Check the microphone on the recording device.`,
    );
    // With the chat closed the bar carries it too.
    t.view.button.click();
    expect(t.view.bar.textContent).toContain('No audio has reached the meeting');

    t.setMeeting({ ...base, coverage: heard({ capturedMs: 11 * MIN, gapsClosed: 1 }) });
    expect(alert(t.view)?.hidden).toBe(true);
    // The loss stays visible after the alert goes.
    expect(status(t.view)?.textContent).toBe('Recording · 11 of 12 min');
    expect(t.view.bar.textContent).not.toContain('No audio has reached the meeting');
  });

  it('names a lost connection as the cause when the recording device drops', async () => {
    const from = Date.now() - 2 * MIN;
    const t = mount(
      meetingFixture({
        recorder: 'rec-elsewhere',
        coverage: heard({
          state: 'gap',
          gap: { from, reason: 'connection' },
          capturedMs: 10 * MIN,
        }),
      }),
    );
    await flush();
    t.view.button.click();
    expect(alert(t.view)?.textContent).toBe(
      `The recording device lost its connection at ${localClock(from)}. Nothing is being recorded.`,
    );
  });

  it('shows nothing before the recording first runs', async () => {
    const t = mount(meetingFixture({ recorder: 'rec-elsewhere' }));
    await flush();
    t.view.button.click();
    expect(status(t.view)?.hidden).toBe(true);
    expect(alert(t.view)?.hidden).toBe(true);
  });
});
