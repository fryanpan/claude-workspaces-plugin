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
import { PANE_OPEN_KEY, lastMeetingDocKey } from '../src/lead-chat/lead-chat-meeting-wiring.ts';
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
    device?: ReturnType<typeof memory>;
    context?: { surface: 'doc'; docId: string } | { surface: 'board' };
  } = {},
) {
  const fake = fakeMeetingClient(opts.meeting ?? null);
  const net = fakeSockets();
  const mic = fakeMic();
  const clock = fakeClock();
  const session = opts.session ?? memory({ [REC_KEY]: 'rec-here' });
  const minted: string[] = [];
  const went: string[] = [];
  /** The meeting verbs sent before each page move. */
  const toldBefore: string[][] = [];
  mounted = mountLeadChat({
    workspaceId: 'w-harbor',
    author: opts.author ?? ALICE,
    getContext: () => opts.context ?? { surface: 'doc', docId: 'd-saltmarsh' },
    client: fake.client,
    storage: opts.device ?? null,
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
      navigate: (path) => {
        went.push(path);
        toldBefore.push(fake.actions());
      },
    },
  });
  const view = mounted.view;
  const tap = (sel: string) => {
    const el = view.root.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`nothing at ${sel}`);
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  };
  return { ...fake, net, mic, clock, session, minted, went, toldBefore, view, tap };
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
    // The heading is one row.
    expect(t.view.meeting.head.hidden).toBe(false);
    expect(t.view.meeting.head.textContent).toContain('Meeting');
    expect(t.view.meeting.head.textContent).toContain('End meeting');
    expect(t.view.meeting.head.textContent).toContain('AR');
    expect(t.view.start.hidden).toBe(true);
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
    // One line: the doc it lands in is the row's tooltip.
    expect(t.view.meeting.notes.querySelector('.lc-notes-row')?.getAttribute('title')).toBe(
      'Notes: Saltmarsh notes',
    );
    expect(t.view.meeting.notes.textContent).toContain('1 line');
    expect(t.view.meeting.notes.textContent).toContain('Bob: Lead, file the ferry timetable.');
    // Another tab records it: this page opens no microphone.
    expect(t.mic.opened).toBe(0);
  });

  it('in a meeting the agent button only opens and closes: the room’s voice is the meeting’s', async () => {
    const t = mount({ meeting: meetingFixture({ recorder: 'rec-elsewhere' }) });
    await flush();
    t.view.button.click();
    expect(t.view.pane.hidden).toBe(false);
    expect(t.view.button.dataset.listening).toBe('false');
    t.view.button.click();
    expect(t.view.pane.hidden).toBe(true);
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

describe('a meeting started with notes opens its notes doc', () => {
  /** Start from the wizard with `doc` picked, or a new doc when it is null. */
  async function startWith(t: ReturnType<typeof mount>, doc: string | null) {
    t.view.button.click();
    t.view.start.click();
    await flush();
    if (doc) {
      const row = [...t.view.root.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (el) => el.textContent === doc,
      );
      if (!row) throw new Error(`no row ${doc}`);
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    } else {
      const r = t.view.root.querySelector<HTMLInputElement>('input[name="wk"][value="new"]');
      if (!r) throw new Error('no new-doc option');
      r.checked = true;
      r.dispatchEvent(new Event('change', { bubbles: true }));
    }
    t.tap('[data-wiz="next"]');
    t.tap('[data-wiz="start"]');
    await flush();
  }

  it('goes to the picked doc once the recording runs there, with the panel kept open', async () => {
    const session = memory({ [REC_KEY]: 'rec-here' });
    const t = mount({ session, context: { surface: 'board' } });
    await startWith(t, 'Harborlight plan');
    expect(t.calls[0]?.body).toMatchObject({ docId: 'd-harbor', notes: 'existing' });
    // Not before the socket says the recording runs.
    expect(t.went).toEqual([]);
    const s = t.net.last();
    s.onopen?.();
    s.say({ type: 'ready', meetingId: 'm-90' });
    await flush();
    expect(t.went).toEqual(['/workspaces/w-harbor/docs/d-harbor']);
    // The board was told the recording runs before the page went.
    expect(t.toldBefore[0]).toContain('recording');
    expect(session.map.get(PANE_OPEN_KEY)).toBe('1');
    // A reconnect later goes nowhere.
    s.say({ type: 'ready', meetingId: 'm-90' });
    await flush();
    expect(t.went).toHaveLength(1);
  });

  it('goes to a doc minted in the wizard', async () => {
    const t = mount({ context: { surface: 'board' } });
    await startWith(t, null);
    t.net.last().onopen?.();
    t.net.last().say({ type: 'ready', meetingId: 'm-91' });
    await flush();
    expect(t.went).toEqual(['/workspaces/w-harbor/docs/d-new']);
  });

  it('goes to the doc the notes really land in when the picked one hands them on', async () => {
    const t = mount({ context: { surface: 'board' } });
    await startWith(t, 'Harborlight plan');
    t.net.last().onopen?.();
    t.net.last().say({
      type: 'notes_doc',
      docId: 'd-rivernote',
      title: 'Riverbend notes',
      url: '/workspaces/w-harbor/docs/d-rivernote',
    });
    const s = t.net.last();
    s.onopen?.();
    s.say({ type: 'ready', meetingId: 'm-92' });
    await flush();
    expect(t.went).toEqual(['/workspaces/w-harbor/docs/d-rivernote']);
  });

  it('stays put when the page already shows the notes doc', async () => {
    const t = mount();
    await startWith(t, 'Saltmarsh notes');
    t.net.last().onopen?.();
    t.net.last().say({ type: 'ready', meetingId: 'm-93' });
    await flush();
    expect(t.went).toEqual([]);
  });

  it('a page that only resumes the recording goes nowhere', async () => {
    const t = mount({
      meeting: meetingFixture({ meetingId: 'm-77', docId: 'd-harbor' }),
      context: { surface: 'board' },
    });
    await flush();
    t.net.last().onopen?.();
    t.net.last().say({ type: 'ready', meetingId: 'm-77' });
    await flush();
    expect(t.went).toEqual([]);
  });

  it('after a move to another page, a later line still goes to the notes doc', async () => {
    const session = memory({ [REC_KEY]: 'rec-here' });
    const first = mount({ session, context: { surface: 'board' } });
    await startWith(first, 'Harborlight plan');
    first.net.last().onopen?.();
    first.net.last().say({ type: 'ready', meetingId: 'm-94' });
    await flush();
    const running = first.client.state().meeting;
    if (!running) throw new Error('no meeting');
    window.dispatchEvent(new Event('pagehide'));
    mounted?.destroy();
    document.body.innerHTML = '';

    // The reader moves on to a page that is not the notes doc.
    const next = mount({
      session,
      meeting: { ...running, meetingId: 'm-94' },
      context: { surface: 'doc', docId: 'd-saltmarsh' },
    });
    await flush();
    const s = next.net.last();
    expect(s.url).toContain('/docs/d-harbor/');
    s.onopen?.();
    expect(s.json()[0]).toMatchObject({ type: 'start', resume: 'm-94' });
    s.say({ type: 'ready', meetingId: 'm-94' });
    s.say({ type: 'transcript', turn: 4, text: 'The ferry leaves at nine.', final: true });
    await flush();
    expect(next.calls.find((c) => c.action === 'line')?.body).toMatchObject({
      id: running.id,
      turn: 4,
      text: 'The ferry leaves at nine.',
    });
    expect(next.went).toEqual([]);
  });
});

describe('the wizard starts on the doc of this board’s last meeting', () => {
  it('picks the last meeting’s doc on this device ahead of this page’s doc', async () => {
    const device = memory();
    const t = mount({ device });
    t.view.button.click();
    t.view.start.click();
    await flush();
    const row = [...t.view.root.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (el) => el.textContent === 'Harborlight plan',
    );
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    t.tap('[data-wiz="next"]');
    t.tap('[data-wiz="start"]');
    await flush();
    expect(device.map.get(lastMeetingDocKey('w-harbor'))).toBe('d-harbor');
    mounted?.destroy();
    document.body.innerHTML = '';

    const next = mount({ device });
    next.view.button.click();
    next.view.start.click();
    await flush();
    expect(next.view.root.querySelector('[aria-selected="true"]')?.textContent).toBe(
      'Harborlight plan',
    );
  });

  it('falls back to this page’s doc when the last one is gone, and is per board', async () => {
    const device = memory({
      [lastMeetingDocKey('w-harbor')]: 'd-archived',
      [lastMeetingDocKey('w-riverbend')]: 'd-harbor',
    });
    const t = mount({ device });
    t.view.button.click();
    t.view.start.click();
    await flush();
    expect(t.view.root.querySelector('[aria-selected="true"]')?.textContent).toBe(
      'Saltmarsh notes',
    );
  });

  it('a meeting with no notes is not remembered and opens no doc', async () => {
    const device = memory();
    const t = mount({ device, context: { surface: 'board' } });
    t.view.button.click();
    t.view.start.click();
    await flush();
    const r = t.view.root.querySelector<HTMLInputElement>('input[name="wk"][value="none"]');
    if (!r) throw new Error('no no-notes option');
    r.checked = true;
    r.dispatchEvent(new Event('change', { bubbles: true }));
    t.tap('[data-wiz="next"]');
    t.tap('[data-wiz="start"]');
    await flush();
    t.net.last().onopen?.();
    t.net.last().say({ type: 'ready', meetingId: 'm-95' });
    await flush();
    expect(t.calls[0]?.body).toMatchObject({ notes: 'none' });
    expect(t.went).toEqual([]);
    expect(device.map.size).toBe(0);
  });
});
