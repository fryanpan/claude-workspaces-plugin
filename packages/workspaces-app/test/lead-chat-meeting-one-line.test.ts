/**
 * A huddle's raw notes in the lead chat are one line beside the typing box,
 * and stay on screen in the bar while the chat is closed. Before this, the
 * notes were a box of every line under the header that took up to 38% of the
 * panel, and closing the chat left nothing of the meeting but the button.
 * Client, socket and microphone are fakes (`lead-chat-meeting-fakes.ts`).
 */
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

function mount(meeting: LeadChatMeeting | null) {
  const fake = fakeMeetingClient(meeting);
  const clock = fakeClock();
  const session = new Map<string, string>([['cw.lead-chat.recorder', 'rec-here']]);
  mounted = mountLeadChat({
    workspaceId: 'w-harbor',
    author: ALICE,
    getContext: () => ({ surface: 'board' }),
    client: fake.client,
    storage: null,
    session: {
      getItem: (k) => session.get(k) ?? null,
      setItem: (k, v) => void session.set(k, v),
      removeItem: (k) => void session.delete(k),
    },
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
      today: new Date(2026, 10, 13),
    },
  });
  return { ...fake, view: mounted.view };
}

const said = (turn: number, who: string, text: string) => ({ turn, who, text, ts: turn + 1 });

const threeLines = meetingFixture({
  recorder: 'rec-elsewhere',
  lines: [
    said(0, 'Alice', 'The Riverbend ferry runs hourly.'),
    said(1, 'Bob', 'Harborlight wants a second slipway.'),
    said(2, 'Alice', 'Saltmarsh pricing comes next week.'),
  ],
});

/** The meeting's lines drawn in the open panel, as a reader sees them. */
const shownLines = (view: LeadChatMount['view']) =>
  [...view.meeting.notes.querySelectorAll<HTMLElement>('.lc-line')].filter(
    (r) => !r.hidden && !r.closest('[hidden]'),
  );

describe('a huddle’s notes in the open lead chat', () => {
  it('show only the newest line, between the messages and the typing box', async () => {
    const t = mount(threeLines);
    await flush();
    t.view.button.click();
    const rows = shownLines(t.view);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Saltmarsh pricing comes next week.');
    expect(t.view.meeting.notes.textContent).not.toContain('Riverbend ferry');
    // Near the typing box: after the message list, before the composer.
    const notes = t.view.meeting.notes;
    expect(t.view.list.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      notes.compareDocumentPosition(t.view.compose.root) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('change in place when a line is said on another page', async () => {
    const t = mount(threeLines);
    await flush();
    t.view.button.click();
    const row = t.view.meeting.notes;
    t.setMeeting({
      ...threeLines,
      lines: [...threeLines.lines, said(3, 'Bob', 'Riverbend signs off on Friday.')],
    });
    expect(t.view.meeting.notes).toBe(row);
    expect(shownLines(t.view)).toHaveLength(1);
    expect(shownLines(t.view)[0]?.textContent).toContain('Riverbend signs off on Friday.');
  });
});

describe('a huddle with the lead chat closed', () => {
  it('keeps the bar on screen with the newest line, and a new line reaches it', async () => {
    const t = mount(threeLines);
    await flush();
    expect(t.view.pane.hidden).toBe(true);
    expect(t.view.bar.hidden).toBe(false);
    expect(t.view.bar.textContent).toContain('Saltmarsh pricing comes next week.');
    t.setMeeting({
      ...threeLines,
      lines: [...threeLines.lines, said(3, 'Bob', 'Riverbend signs off on Friday.')],
    });
    expect(t.view.bar.hidden).toBe(false);
    expect(t.view.bar.textContent).toContain('Riverbend signs off on Friday.');
  });

  it('stays after the chat is opened and closed again, and a tap on it opens the chat', async () => {
    const t = mount(threeLines);
    await flush();
    t.view.button.click();
    expect(t.view.bar.hidden).toBe(true);
    t.view.close.click();
    expect(t.view.pane.hidden).toBe(true);
    expect(t.view.bar.hidden).toBe(false);
    t.view.bar.click();
    expect(t.view.pane.hidden).toBe(false);
  });

  it('goes when the meeting ends, and is not there with no meeting', async () => {
    const t = mount(threeLines);
    await flush();
    expect(t.view.bar.hidden).toBe(false);
    t.setMeeting(null);
    expect(t.view.bar.hidden).toBe(true);
    mounted?.destroy();
    const idle = mount(null);
    await flush();
    expect(idle.view.bar.hidden).toBe(true);
  });
});
