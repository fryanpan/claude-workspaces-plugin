/**
 * Workflow B's stream: each thing he does becomes one event, a repeat
 * becomes none, and arriving somewhere new says he moved.
 */
import { describe, expect, it } from 'bun:test';
import type { Event } from '../src/activity.ts';
import { CoachStream, PASSAGE_CHARS, TEXT_CHARS } from '../src/coach/stream.ts';
import { WS, at } from './coach-fixtures.ts';

const view = (s: CoachStream, when: number, docId: string | undefined, extra = {}) =>
  s.here({
    at: when,
    kind: 'view',
    workspaceId: WS,
    ...(docId ? { docId } : {}),
    visible: true,
    ...extra,
  });

const row = (type: string, docId: string, payload = {}, isOwner = true) =>
  ({
    type,
    isOwner,
    ts: new Date(at(9)).toISOString(),
    doc: { docId },
    payload,
  }) as unknown as Event;

describe('views', () => {
  it('sends a place, heading or passage change, and drops a repeat', () => {
    const s = new CoachStream();
    expect(view(s, at(9), 'd-post', { heading: 'Why', text: 'a' })).toEqual({
      events: [
        { kind: 'view', at: at(9), workspaceId: WS, docId: 'd-post', heading: 'Why', text: 'a' },
      ],
      moved: true,
    });
    expect(view(s, at(9, 1), 'd-post', { heading: 'Why', text: 'a' }).events).toEqual([]);
    expect(view(s, at(9, 2), 'd-post', { heading: 'How', text: 'a' }).events).toHaveLength(1);
    expect(view(s, at(9, 3), undefined)).toMatchObject({ moved: true, events: [{ kind: 'view' }] });
  });

  it('a hidden tab is one left, and showing it again is a view', () => {
    const s = new CoachStream();
    view(s, at(9), 'd-post', { text: 'a' });
    const hide = () =>
      s.here({ at: at(9, 5), kind: 'view', workspaceId: WS, docId: 'd-post', visible: false });
    expect(hide().events.map((e) => e.kind)).toEqual(['left']);
    expect(hide().events).toEqual([]);
    expect(view(s, at(9, 6), 'd-post', { text: 'a' })).toMatchObject({
      moved: false,
      events: [{ kind: 'view' }],
    });
  });

  it('caps the passage and squashes its spacing', () => {
    const s = new CoachStream();
    const step = view(s, at(9), 'd-post', { text: `  a\n\n${'b'.repeat(PASSAGE_CHARS * 2)}` });
    expect(step.events[0]?.text?.length).toBe(PASSAGE_CHARS);
    expect(step.events[0]?.text?.startsWith('a b')).toBe(true);
  });
});

describe('what he wrote', () => {
  it('sends each new paragraph once, capped', () => {
    const s = new CoachStream();
    const wrote = (text: string) =>
      s.here({ at: at(9), kind: 'wrote', workspaceId: WS, docId: 'd-post', visible: true, text });
    expect(wrote('one').events.map((e) => e.text)).toEqual(['one']);
    expect(wrote('one').events).toEqual([]);
    expect(wrote('one two').events.map((e) => e.text)).toEqual(['one two']);
    expect(wrote('x'.repeat(TEXT_CHARS + 9)).events[0]?.text?.length).toBe(TEXT_CHARS);
  });
});

describe('activity rows', () => {
  it('comments and replies carry their text; an open is a move; edits, reads and agents are nothing', () => {
    const s = new CoachStream();
    const ws = () => WS;
    expect(s.activity(row('comment', 'd-hover', { text: 'Softer?' }), at(9), ws).events).toEqual([
      { kind: 'comment', at: at(9), workspaceId: WS, docId: 'd-hover', text: 'Softer?' },
    ]);
    expect(s.activity(row('doc_open', 'd-mock'), at(9), ws)).toMatchObject({
      moved: true,
      events: [{ kind: 'open', docId: 'd-mock' }],
    });
    expect(s.activity(row('doc_open', 'd-mock'), at(9), ws).events).toEqual([]);
    expect(s.activity(row('edit_session', 'd-mock', { editCount: 3 }), at(9), ws).events).toEqual(
      [],
    );
    expect(s.activity(row('read_session', 'd-mock'), at(9), ws).events).toEqual([]);
    expect(s.activity(row('comment', 'd-mock', { text: 'x' }, false), at(9), ws).events).toEqual(
      [],
    );
  });
});
