import { describe, expect, it } from 'vitest';
import { type RosterTurn, speakerRoster } from './speaker-roster.ts';

describe('speakerRoster — who the reassign popover can offer', () => {
  // Shaped like the transcript rows the API returns — `turn` and `ts` ride
  // along and the roster reads neither, which is the point of the type.
  const turns: RosterTurn[] = [
    { text: 'Move the gate.', speaker: 'A' },
    { text: 'Not before Friday.', speaker: 'B' },
    { text: 'Then Monday.', speaker: 'A' },
    { text: 'Someone coughed.' },
  ];

  it('names every voice that spoke, with the last thing it said', () => {
    expect(speakerRoster(turns, { A: 'Mallory' })).toEqual([
      { label: 'A', name: 'Mallory', given: 'Mallory', lastSaid: 'Then Monday.' },
      { label: 'B', name: 'Speaker B', lastSaid: 'Not before Friday.' },
    ]);
  });

  it('offers a named voice that has not spoken yet', () => {
    // Naming happens on the strip and can land before that voice's first
    // settled turn. A roster that waited for speech would leave the person
    // unable to reassign to somebody they had just named.
    const roster = speakerRoster(turns, { C: 'Bob' });
    expect(roster.map((v) => v.label)).toEqual(['A', 'B', 'C']);
    expect(roster[2]).toEqual({ label: 'C', name: 'Bob', given: 'Bob', lastSaid: '' });
  });

  it('ignores turns nobody was labelled for — a solo capture offers nothing', () => {
    expect(speakerRoster([{ text: 'Just me talking.' }], {})).toEqual([]);
  });

  it('orders by label so the list does not reshuffle as people speak', () => {
    const spoken = [
      { text: 'first', speaker: 'B' },
      { text: 'second', speaker: 'A' },
    ];
    expect(speakerRoster(spoken, {}).map((v) => v.label)).toEqual(['A', 'B']);
  });

  it('takes the LAST thing said, not the longest or the first', () => {
    const spoken = [
      { text: 'a much longer earlier sentence', speaker: 'A' },
      { text: 'ok', speaker: 'A' },
    ];
    expect(speakerRoster(spoken, {})[0]?.lastSaid).toBe('ok');
  });

  it('carries the bare saved name a rename prompt starts from, and nothing else', () => {
    // An unnamed voice offers no seed at all, so its prompt opens empty
    // rather than pre-filled with the placeholder somebody would press OK on.
    const roster = speakerRoster([{ text: 'hi', speaker: 'room:A' }], {
      'room:A': 'Trent (Room)',
      'room:B': 'Room Speaker B',
    });
    expect(roster.find((v) => v.label === 'room:A')).toMatchObject({
      name: 'Trent',
      given: 'Trent',
    });
    const anonymous = roster.find((v) => v.label === 'room:B');
    expect(anonymous?.name).toBe('Room Speaker B');
    expect(anonymous?.given).toBeUndefined();
  });
});
