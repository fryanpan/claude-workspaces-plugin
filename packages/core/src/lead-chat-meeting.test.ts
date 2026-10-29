import { describe, expect, it } from 'vitest';
import { addressesLead, upsertMeetingLine } from './lead-chat.ts';
import { parseMeetingClientMessage } from './meeting-parse.ts';

describe('a line said in a meeting', () => {
  it('reaches the lead only when it opens with "Lead,"', () => {
    expect(addressesLead('Lead, file a task to price the slipway.')).toBe(true);
    expect(addressesLead('lead: what is left on Riverbend?')).toBe(true);
    // The room talking, not an ask.
    expect(addressesLead('Lead the review, Alice.')).toBe(false);
    expect(addressesLead('Lead time is two weeks.')).toBe(false);
    expect(addressesLead('Leading with the ferry times.')).toBe(false);
    expect(addressesLead('Alice, can you lead the review?')).toBe(false);
    expect(addressesLead('Lead,')).toBe(false);
  });

  it('replaces a revised turn in place and keeps turn order', () => {
    const a = upsertMeetingLine([], { turn: 1, who: 'Bob', text: 'second', ts: 2 });
    const b = upsertMeetingLine(a, { turn: 0, who: 'Alice', text: 'first', ts: 1 });
    const c = upsertMeetingLine(b, { turn: 1, who: 'Bob', text: 'second, revised', ts: 3 });
    expect(c.map((l) => l.text)).toEqual(['first', 'second, revised']);
  });
});

describe('the start frame’s notes field', () => {
  const start = { type: 'start', sampleRate: 16_000, encoding: 'pcm_s16le', mode: 'solo' };
  it('turns the note-taker off only for the literal false', () => {
    expect(parseMeetingClientMessage(JSON.stringify({ ...start, notes: false }))).toMatchObject({
      notes: false,
    });
    expect(parseMeetingClientMessage(JSON.stringify({ ...start, notes: 'no' }))).not.toHaveProperty(
      'notes',
    );
    expect(parseMeetingClientMessage(JSON.stringify(start))).not.toHaveProperty('notes');
  });
});
