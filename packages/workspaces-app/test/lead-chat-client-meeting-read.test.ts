/**
 * The lead chat client keeps each meeting line the stream delivered while a
 * read was out, so a read whose answer was taken before that line does not
 * erase it.
 */
import { LEAD_CHAT_MEETING_LINE_EVENT } from '@claude-workspaces/core/lead-chat';
import { describe, expect, it } from 'vitest';
import { createLeadChatClient } from '../src/lead-chat/lead-chat-client.ts';
import { FakeStream, settle } from './lead-chat-fake-stream.ts';

describe('the lead chat client, while a read is out', () => {
  it('keeps a meeting line heard while a read was out, whose answer predates it', async () => {
    // A page opened while its stream is still connecting reads twice: once at
    // once, and again when the stream opens. A line said in between reached
    // the page as a frame and was then wiped by the second read's answer,
    // taken before the line was said; the watching tab never showed it
    // (lead-chat-meeting-browser, CI, 25 Nov).
    const meeting = {
      id: 'lcm-1',
      startedAt: 1,
      by: { id: 'known-alice', name: 'Alice' },
      docId: 'd-salt',
      docTitle: 'Saltmarsh notes',
      notes: 'existing',
      source: 'mic',
      speakers: 'conversation',
      recorder: 'rec-1',
      people: [],
      lines: [],
    };
    const stream = new FakeStream('board');
    const answers: Array<(body: unknown) => void> = [];
    const client = createLeadChatClient({
      workspaceId: 'w-harbor',
      stream: stream as unknown as EventSource,
      fetch: (() =>
        new Promise<Response>((resolve) => {
          answers.push((body) => resolve(new Response(JSON.stringify(body))));
        })) as unknown as typeof fetch,
    });
    answers[0]?.({ lead: null, messages: [], canTalk: true, meeting });
    await settle();
    expect(client.state().meeting?.id).toBe('lcm-1');
    stream.fire('open');
    expect(answers).toHaveLength(2);
    const line = { turn: 0, who: 'Alice', text: 'The slipway opens at nine.', ts: 2 };
    stream.fire(LEAD_CHAT_MEETING_LINE_EVENT, { workspaceId: 'w-harbor', meeting: 'lcm-1', line });
    answers[1]?.({ lead: null, messages: [], canTalk: true, meeting });
    await settle();
    expect(client.state().meeting?.lines).toEqual([line]);
    // A read taken AFTER the line holds it already, and keeps it once.
    stream.fire('error');
    stream.fire('open');
    answers[2]?.({
      lead: null,
      messages: [],
      canTalk: true,
      meeting: { ...meeting, lines: [line] },
    });
    await settle();
    expect(client.state().meeting?.lines).toEqual([line]);
  });

  it('keeps a meeting line heard before the read that brings the meeting answers', async () => {
    const meeting = {
      id: 'lcm-1',
      startedAt: 1,
      by: { id: 'known-alice', name: 'Alice' },
      docId: 'd-salt',
      docTitle: 'Saltmarsh notes',
      notes: 'existing',
      source: 'mic',
      speakers: 'conversation',
      recorder: 'rec-1',
      people: [],
      lines: [],
    };
    const stream = new FakeStream('board');
    stream.readyState = 1;
    const answers: Array<(body: unknown) => void> = [];
    const client = createLeadChatClient({
      workspaceId: 'w-harbor',
      stream: stream as unknown as EventSource,
      fetch: (() =>
        new Promise<Response>((resolve) => {
          answers.push((body) => resolve(new Response(JSON.stringify(body))));
        })) as unknown as typeof fetch,
    });
    const line = { turn: 0, who: 'Bob', text: 'The ferry leaves at ten.', ts: 2 };
    stream.fire(LEAD_CHAT_MEETING_LINE_EVENT, { workspaceId: 'w-harbor', meeting: 'lcm-1', line });
    // Another meeting's line is not put on this one.
    stream.fire(LEAD_CHAT_MEETING_LINE_EVENT, {
      workspaceId: 'w-harbor',
      meeting: 'lcm-0',
      line: { ...line, turn: 1 },
    });
    answers[0]?.({ lead: null, messages: [], canTalk: true, meeting });
    await settle();
    expect(client.state().meeting?.lines).toEqual([line]);
  });
});
