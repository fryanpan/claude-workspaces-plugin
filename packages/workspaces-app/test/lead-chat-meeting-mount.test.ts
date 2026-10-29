/**
 * The lead chat's meeting on a page (`lead-chat-meeting-wiring.ts` through
 * `mountLeadChat`): Start a meeting opens the wizard and its Start starts the
 * board's meeting and the recording; the heading is one row with End meeting;
 * the live notes show each line; the tab that records resumes on the next
 * page and nobody else's does; a meeting ended elsewhere stops it here.
 * Client, socket and microphone are fakes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NOTES_EMPTY } from '../src/lead-chat/lead-chat-meeting-view.ts';
import { PANE_OPEN_KEY } from '../src/lead-chat/lead-chat-meeting-wiring.ts';
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

function memory(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    map: m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

let mounted: LeadChatMount | null = null;
afterEach(() => {
  mounted?.destroy();
  mounted = null;
  document.body.innerHTML = '';
});

function mount(
  opts: {
    meeting?: ReturnType<typeof meetingFixture> | null;
    session?: ReturnType<typeof memory>;
    author?: typeof ALICE;
  } = {},
) {
  const fake = fakeMeetingClient(opts.meeting ?? null);
  const net = fakeSockets();
  const mic = fakeMic();
  const clock = fakeClock();
  const session = opts.session ?? memory({ [REC_KEY]: 'rec-here' });
  const minted: string[] = [];
  mounted = mountLeadChat({
    workspaceId: 'w-harbor',
    author: opts.author ?? ALICE,
    getContext: () => ({ surface: 'doc', docId: 'd-saltmarsh' }),
    client: fake.client,
    storage: null,
    session,
    voice: fakeVoice().seams,
    reducedMotion: () => true,
    meeting: {
      openSocket: net.openSocket,
      startCapture: mic.startCapture,
      createAudioContext: () => ({}) as AudioContext,
      now: clock.now,
      schedule: clock.schedule,
      loadDocs: async () => [
        { docId: 'd-harbor', title: 'Harborlight plan' },
        { docId: 'd-saltmarsh', title: 'Saltmarsh notes' },
      ],
      newDoc: async (topic) => {
        minted.push(topic);
        return 'd-new';
      },
      macAudio: false,
      today: new Date(2026, 9, 29),
    },
  });
  const view = mounted.view;
  const tap = (sel: string) => {
    const el = view.root.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`nothing at ${sel}`);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  };
  return { ...fake, net, mic, clock, session, minted, view, tap };
}

describe('the lead chat meeting on a page', () => {
  it('Start a meeting: the wizard picks this page’s doc, and Start records into it', async () => {
    const t = mount();
    t.view.button.click();
    expect(t.view.start.hidden).toBe(false);
    t.view.start.click();
    await flush();
    expect(t.view.root.querySelector('[aria-selected="true"]')?.textContent).toBe(
      'Saltmarsh notes',
    );
    t.tap('[data-wiz="next"]');
    t.tap('[data-wiz="start"]');
    await flush();
    expect(t.calls[0]).toMatchObject({
      action: 'start',
      body: { docId: 'd-saltmarsh', notes: 'existing', source: 'mic', recorder: 'rec-here' },
    });
    expect(t.mic.opened).toBe(1);
    expect(t.net.last().url).toContain('/docs/d-saltmarsh/');
    // The heading is one row; the chat's own mic steps aside.
    expect(t.view.meeting.head.hidden).toBe(false);
    expect(t.view.meeting.head.textContent).toContain('Meeting');
    expect(t.view.meeting.head.textContent).toContain('End meeting');
    expect(t.view.meeting.head.textContent).toContain('AR');
    expect(t.view.start.hidden).toBe(true);
    expect(t.view.mic.hidden).toBe(true);
    expect(t.view.meeting.notes.textContent).toContain(NOTES_EMPTY);
    expect(t.view.button.dataset.meeting).toBe('true');
  });

  it('a new doc is minted under the name the wizard holds', async () => {
    const t = mount();
    t.view.button.click();
    t.view.start.click();
    await flush();
    const r = t.view.root.querySelector<HTMLInputElement>('input[name="wk"][value="new"]');
    if (!r) throw new Error('no new-doc option');
    r.checked = true;
    r.dispatchEvent(new Event('change', { bubbles: true }));
    t.tap('[data-wiz="next"]');
    t.tap('[data-wiz="start"]');
    await flush();
    expect(t.minted).toEqual(['Meeting notes, 29 Oct']);
    expect(t.calls[0]?.body).toMatchObject({
      docId: 'd-new',
      docTitle: 'Meeting notes, 29 Oct',
      notes: 'new',
    });
  });

  it('shows each line as it is said, with the doc and the count', async () => {
    const t = mount({ meeting: meetingFixture({ recorder: 'rec-elsewhere' }) });
    t.view.button.click();
    t.setMeeting(
      meetingFixture({
        recorder: 'rec-elsewhere',
        lines: [{ turn: 0, who: 'Bob', text: 'Lead, file the ferry timetable.', ts: 2 }],
      }),
    );
    expect(t.view.meeting.notes.textContent).toContain('Saltmarsh notes');
    expect(t.view.meeting.notes.textContent).toContain('1 line');
    expect(t.view.meeting.notes.textContent).toContain('BobLead, file the ferry timetable.');
    // Another tab records it: this page opens no microphone.
    expect(t.mic.opened).toBe(0);
  });

  it('the recording tab resumes the same recording on its next page, with no tap', async () => {
    const t = mount({ meeting: meetingFixture({ meetingId: 'm-77' }) });
    await flush();
    expect(t.mic.opened).toBe(1);
    t.net.last().onopen?.();
    expect(t.net.last().json()[0]).toMatchObject({ type: 'start', resume: 'm-77' });
  });

  it('a person who opens a page of the board joins, once', async () => {
    const bob = { id: 'known-bob', name: 'Bob', kind: 'known' };
    const t = mount({ meeting: meetingFixture({ recorder: 'rec-elsewhere' }), author: bob });
    await flush();
    expect(t.view.meeting.head.querySelectorAll('.lc-face')).toHaveLength(2);
    // A later frame that has not caught up with the join asks nothing again.
    t.setMeeting(meetingFixture({ recorder: 'rec-elsewhere' }));
    expect(t.actions().filter((a) => a === 'join')).toHaveLength(1);
  });

  it('End meeting ends it for the board and stops the recording', async () => {
    const t = mount({ meeting: meetingFixture({ meetingId: 'm-77' }) });
    await flush();
    const s = t.net.last();
    s.onopen?.();
    t.view.button.click();
    t.view.meeting.end.click();
    await flush();
    expect(s.json().at(-1)).toEqual({ type: 'stop' });
    expect(t.actions()).toContain('end');
    expect(t.view.meeting.head.hidden).toBe(true);
    expect(t.view.start.hidden).toBe(false);
  });

  it('a meeting ended on another page stops the recording here', async () => {
    const t = mount({ meeting: meetingFixture({ meetingId: 'm-77' }) });
    await flush();
    const s = t.net.last();
    s.onopen?.();
    t.setMeeting(null);
    expect(s.json().at(-1)).toEqual({ type: 'stop' });
    expect(t.mic.stopped).toBe(1);
  });

  it('leaving the page releases the microphone without ending, and the next page reopens the panel', async () => {
    const session = memory({ [REC_KEY]: 'rec-here' });
    const t = mount({ meeting: meetingFixture({ meetingId: 'm-77' }), session });
    await flush();
    const s = t.net.last();
    s.onopen?.();
    t.view.button.click();
    window.dispatchEvent(new Event('pagehide'));
    expect(s.closed).toBe(true);
    expect(s.json().some((f) => f.type === 'stop')).toBe(false);
    expect(session.map.get(PANE_OPEN_KEY)).toBe('1');
    mounted?.destroy();
    document.body.innerHTML = '';

    const next = mount({ meeting: meetingFixture({ meetingId: 'm-77' }), session });
    await flush();
    expect(next.view.pane.hidden).toBe(false);
  });
});
