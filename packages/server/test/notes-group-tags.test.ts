/**
 * A run of notes from one voice carries ONE name, on the bullet above them.
 *
 * Driven through `applyNotesUpdate` rather than through the pass alone,
 * because the reach has to survive the whole write: the guard, the section
 * resolution and the applier all sit between a tick's edits and the doc, and
 * a pass wired in after the wrong one of them would be invisible to a test
 * that called it directly. The two cases that cannot be reached that way —
 * a note a person has taken over, and a mention the meeting is unsure of —
 * call the pass on a doc the write path built.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, test } from 'bun:test';
import { findSpeakerTags, prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { applyNotesUpdate, createNotesHeadingMemory } from '../src/meeting-notes-doc.ts';
import type { NotesUpdate } from '../src/meeting-notes.ts';
import { NOTES_AUTHOR_ID, applyNotesBlockEdits } from '../src/notes-doc-access.ts';
import { retagNotesGroups } from '../src/notes-group-tags.ts';
import { decisionsWithoutSpeaker } from '../src/notes-quality.ts';
import { oneDocStore } from './notes-doc-helpers.ts';

/** A doc the note-taker wrote this markdown into, through the real write. */
function written(markdown: string): Y.Doc {
  const ydoc = new Y.Doc();
  const store = oneDocStore('d', { ydoc, meta: { type: 'markdown' } });
  applyNotesUpdate(
    store,
    {
      docId: 'd',
      meetingId: 'm',
      tick: { tick: 1, reason: 'pause', turns: [] },
      edits: [{ op: 'insert_at_end', markdown }],
    } as unknown as NotesUpdate,
    createNotesHeadingMemory(),
  );
  return ydoc;
}

/**
 * The same markdown written by the note-taker WITHOUT the pass running — the
 * shape a tick leaves behind before anything retags it.
 *
 * `applyNotesUpdate` retags as part of the write, which is the point of it,
 * so a test that wants to run the pass by hand (and one that wants to prove
 * the pass is what changes the doc) cannot build its fixture that way.
 */
function untouched(markdown: string): Y.Doc {
  const ydoc = new Y.Doc();
  const store = oneDocStore('d', { ydoc, meta: { type: 'markdown' } });
  applyNotesBlockEdits(store, 'd', [{ op: 'insert_at_end', markdown }]);
  return ydoc;
}

function notesOf(ydoc: Y.Doc): string {
  return prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
}

/** What a reader counts: how many names are printed down the section. */
function tagCount(markdown: string): number {
  return findSpeakerTags(markdown).length;
}

/**
 * The lines of the section, list markers and nesting kept.
 *
 * Indentation is normalized to one step of two spaces per level, because a
 * fixture is written the way a composer writes markdown (four) and the
 * serializer writes it back the way the document holds it (two). The nesting
 * these tests assert about is the level, not the column.
 */
function lines(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map((l) => {
      const indent = l.length - l.trimStart().length;
      return '  '.repeat(Math.round(indent / 4) || (indent > 0 ? 1 : 0)) + l.trimStart();
    });
}

const HEADING = '## Meeting notes';

/** The id of the section heading, for a caller driving the pass by hand. */
function headingId(ydoc: Y.Doc): string {
  const top = prose.getProseFragment(ydoc).toArray();
  for (const el of top) {
    if (el instanceof Y.XmlElement && el.nodeName === 'heading') {
      const id = prose.readBlockId(el);
      if (id !== undefined) return id;
    }
  }
  throw new Error('no heading');
}

/** The text node of the nth note under the first lead bullet. */
function noteLine(ydoc: Y.Doc, n: number): Y.XmlText {
  const found: Y.XmlText[] = [];
  const collect = (el: Y.XmlElement, depth: number): void => {
    for (const child of el.toArray()) {
      if (child instanceof Y.XmlText) {
        if (depth >= 2) found.push(child);
      } else if (child instanceof Y.XmlElement) {
        collect(child, child.nodeName === 'listItem' ? depth + 1 : depth);
      }
    }
  };
  for (const top of prose.getProseFragment(ydoc).toArray()) {
    if (top instanceof Y.XmlElement && top.nodeName === 'bulletList') collect(top, 0);
  }
  const node = found[n];
  if (node === undefined) throw new Error(`no note ${n}`);
  return node;
}

describe('a single-voice group', () => {
  test('carries one tag on its lead bullet instead of one per note', () => {
    const before = `${HEADING}

- Ferry timetable
    - [@Devi](speaker:B?t=1) wants the 07:40 back
    - [@Devi](speaker:B?t=2) says the ramp is the problem
    - [@Devi](speaker:B?t=3) will ask the operator
`;
    expect(tagCount(before)).toBe(3);
    const after = notesOf(written(before));
    expect(tagCount(after)).toBe(1);
    // On the LEAD bullet, and the notes under it keep every word.
    expect(lines(after)[1]).toBe('- [@Devi](speaker:B?t=1,2,3&g=3): Ferry timetable');
    expect(after).toContain('Wants the 07:40 back');
    expect(after).toContain('Says the ramp is the problem');
    expect(after).toContain('Will ask the operator');
  });

  test('is still attributable for a decision written inside it', () => {
    const after = notesOf(
      written(`${HEADING}

- Ferry timetable
    - [@Devi](speaker:B?t=1) says the ramp is the problem
    - [@Devi](speaker:B?t=2) we will move the 07:40 sailing
`),
    );
    // The decision line no longer carries a name of its own; the bar has to
    // read the one above it, or this pass reports itself as a regression.
    expect(decisionsWithoutSpeaker(after)).toEqual([]);
  });

  test('does not fold a run of one note, which is no column at all', () => {
    const before = `${HEADING}

- Ferry timetable
    - [@Devi](speaker:B?t=1) wants the 07:40 back
`;
    expect(lines(notesOf(written(before)))).toEqual(lines(before));
  });
});

describe('a group that mixes voices', () => {
  test('is tagged note by note, and is never split by speaker', () => {
    const after = notesOf(
      written(`${HEADING}

- Ferry timetable
    - [@Devi](speaker:B?t=1) wants the 07:40 back
    - [@Wren](speaker:C?t=2) says the slipway costs more
    - [@Devi](speaker:B?t=3) asks what the operator charges
`),
    );
    // Both voices, still under ONE topic bullet — the grouping is by what
    // they are talking about, never by who is talking.
    expect(tagCount(after)).toBe(3);
    expect(lines(after)).toEqual([
      HEADING,
      '- Ferry timetable',
      '  - [@Devi](speaker:B?t=1) wants the 07:40 back',
      '  - [@Wren](speaker:C?t=2) says the slipway costs more',
      '  - [@Devi](speaker:B?t=3) asks what the operator charges',
    ]);
  });

  test('keeps an open question in it attributable to the voice that asked', () => {
    const after = notesOf(
      written(`${HEADING}

- Ferry timetable
    - [@Devi](speaker:B?t=1) asked whether the ramp is funded
    - [@Wren](speaker:C?t=2) says the slipway costs more
`),
    );
    expect(decisionsWithoutSpeaker(after)).toEqual([]);
  });
});

describe('a group whose voices change', () => {
  test('gaining a second voice gets its per-note tags back', () => {
    const after = notesOf(
      written(`${HEADING}

- [@Devi](speaker:B?t=1,2&g=2): Ferry timetable
    - Wants the 07:40 back
    - Says the ramp is the problem
    - [@Wren](speaker:C?t=5) says the slipway costs more
`),
    );
    expect(lines(after)).toEqual([
      HEADING,
      '- Ferry timetable',
      '  - [@Devi](speaker:B?t=): Wants the 07:40 back',
      '  - [@Devi](speaker:B?t=): Says the ramp is the problem',
      '  - [@Wren](speaker:C?t=5) says the slipway costs more',
    ]);
  });

  test('gaining another note from the SAME voice folds it into the one tag', () => {
    const after = notesOf(
      written(`${HEADING}

- [@Devi](speaker:B?t=1,2&g=2): Ferry timetable
    - Wants the 07:40 back
    - [@Devi](speaker:B?t=7) adds that the ramp is the problem
`),
    );
    expect(tagCount(after)).toBe(1);
    // The lead bullet's mention now speaks for turn 7 as well, so a later
    // revision of that turn can still find the words it moved.
    expect(lines(after)[1]).toBe('- [@Devi](speaker:B?t=1,2,7&g=2): Ferry timetable');
  });
});

describe('a note nobody attributed, landing in a folded group', () => {
  test('takes the lead mention off rather than claiming the note', () => {
    const after = notesOf(
      written(`${HEADING}

- [@Devi](speaker:B?t=1,2&g=2): Ferry timetable
    - Wants the 07:40 sailing back
    - Says the ramp is the real cost
    - The room agreed to ask the operator
`),
    );
    // The marker counted two folded notes and there are three untagged ones,
    // so one arrived that the fold never took a tag off. The mention cannot
    // say which, and a guess would put Devi's name on a note about the room.
    expect(tagCount(after)).toBe(0);
    expect(lines(after)).toEqual([
      HEADING,
      '- Ferry timetable',
      '  - Wants the 07:40 sailing back',
      '  - Says the ramp is the real cost',
      '  - The room agreed to ask the operator',
    ]);
  });

  test('is never handed the group voice when a second voice arrives', () => {
    const after = notesOf(
      written(`${HEADING}

- [@Devi](speaker:B?t=1,2&g=2): Ferry timetable
    - Wants the 07:40 sailing back
    - Says the ramp is the real cost
    - The room agreed to ask the operator
    - [@Wren](speaker:C?t=5) says the slipway costs more
`),
    );
    // The push-down would have given all three untagged notes Devi's name.
    expect(after).not.toContain('[@Devi]');
    expect(tagCount(after)).toBe(1);
    expect(after).toContain('The room agreed to ask the operator');
  });
});

describe('the attribution bar', () => {
  test('inherits from a group tag but not from an ordinary one', () => {
    const grouped = `${HEADING}

- [@Devi](speaker:B?t=1,2&g=2): Ferry timetable
    - Says the ramp is the real cost
    - We will move the 07:40 sailing
`;
    expect(decisionsWithoutSpeaker(grouped)).toEqual([]);

    // The same shape with an ORDINARY mention on the lead bullet: that names
    // whoever opened the topic, and says nothing about who decided.
    const opened = `${HEADING}

- [@Devi](speaker:B?t=1) opened the ferry timetable
    - Says the ramp is the real cost
    - We will move the 07:40 sailing
`;
    expect(decisionsWithoutSpeaker(opened)).toEqual(['We will move the 07:40 sailing']);
  });
});

describe('what the pass will not touch', () => {
  test('a lead bullet the composer tagged itself', () => {
    const before = `${HEADING}

- [@Devi](speaker:B?t=1) opened the ferry timetable
    - [@Devi](speaker:B?t=2) wants the 07:40 back
    - [@Devi](speaker:B?t=3) says the ramp is the problem
`;
    // No group marker up there, so there would be no way to undo the fold if
    // a second voice joined — and its name was a note, not a stand-in.
    expect(lines(notesOf(written(before)))).toEqual(lines(before));
  });

  test('a group holding a mention the meeting is unsure of', () => {
    const before = `${HEADING}

- Ferry timetable
    - [@Devi](speaker:B?t=1&unsure=1) wants the 07:40 back
    - [@Devi](speaker:B?t=2) says the ramp is the problem
`;
    expect(lines(notesOf(written(before)))).toEqual(lines(before));
  });

  test('a note a person has taken over — nor the group it is in', () => {
    const fixture = `${HEADING}

- Ferry timetable
    - [@Devi](speaker:B?t=1) wants the 07:40 back
    - [@Devi](speaker:B?t=2) says the ramp is the problem
`;
    // The control: with nobody's hands on it, this group folds.
    const own = untouched(fixture);
    expect(retagNotesGroups(own, headingId(own), { author: NOTES_AUTHOR_ID }).hoisted).toBe(1);

    // A person types at the end of the second note: that block is theirs now.
    const edited = untouched(fixture);
    const line = noteLine(edited, 1);
    // A NON-STRING origin is what `isPersonOrigin` reads as a person; a
    // string origin is the server writing on its own behalf.
    edited.transact(() => line.insert(line.length, ' \u2014 and the tide'), { person: true });
    const was = notesOf(edited);
    expect(retagNotesGroups(edited, headingId(edited), { author: NOTES_AUTHOR_ID })).toEqual({
      hoisted: 0,
      cleared: 0,
      restored: 0,
      unfolded: 0,
    });
    expect(notesOf(edited)).toBe(was);
    expect(notesOf(edited)).toContain('\u2014 and the tide');
  });
});
