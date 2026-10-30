/**
 * The lead chat's message shape: what the parser keeps from the wire or the
 * log, what it refuses, and how a message seen twice stays one row in time
 * order.
 */
import { describe, expect, it } from 'vitest';
import {
  LEAD_CHAT_MAX_CHARS,
  type LeadChatMessage,
  parseLeadChatMessage,
  upsertLeadChatMessage,
} from '../src/lead-chat.ts';

const base = {
  id: 'm1',
  role: 'person',
  author: { id: 'known-alice', name: 'Alice' },
  text: 'What is left on the Saltmarsh signup?',
  ts: 10,
};

describe('parseLeadChatMessage', () => {
  it('keeps a well-formed message, with its optional fields', () => {
    expect(
      parseLeadChatMessage({ ...base, via: 'voice', state: 'answered', replyTo: 'm0', extra: 1 }),
    ).toEqual({ ...base, via: 'voice', state: 'answered', replyTo: 'm0' });
  });

  it('drops an unknown via or state rather than the message', () => {
    expect(parseLeadChatMessage({ ...base, via: 'fax', state: 'lost' })).toEqual(base);
  });

  it.each([
    ['not an object', 'hello'],
    ['null', null],
    ['no id', { ...base, id: '' }],
    ['no text', { ...base, text: '' }],
    ['text far over the cap', { ...base, text: 'x'.repeat(LEAD_CHAT_MAX_CHARS * 2 + 1) }],
    ['no author', { ...base, author: undefined }],
    ['an author with no name', { ...base, author: { id: 'known-alice' } }],
    ['a role it does not know', { ...base, role: 'system' }],
    ['a ts that is not a number', { ...base, ts: 'soon' }],
    ['a ts that is not finite', { ...base, ts: Number.POSITIVE_INFINITY }],
  ])('refuses %s', (_why, raw) => {
    expect(parseLeadChatMessage(raw)).toBeNull();
  });
});

describe('upsertLeadChatMessage', () => {
  const m = (id: string, ts: number): LeadChatMessage => ({
    ...(base as LeadChatMessage),
    id,
    ts,
  });

  it('replaces a message seen twice and keeps time order', () => {
    const list = [m('a', 1), m('c', 3)];
    const out = upsertLeadChatMessage(list, { ...m('a', 1), state: 'answered' });
    expect(out.map((x) => [x.id, x.state])).toEqual([
      ['a', 'answered'],
      ['c', undefined],
    ]);
    expect(upsertLeadChatMessage(out, m('b', 2)).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    // The list handed in is not changed.
    expect(list.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('orders two messages with one timestamp by id', () => {
    expect(upsertLeadChatMessage([m('y', 5)], m('x', 5)).map((x) => x.id)).toEqual(['x', 'y']);
  });
});
