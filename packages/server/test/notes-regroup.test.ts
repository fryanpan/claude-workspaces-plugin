/**
 * When the note-taker is told a topic has filled up, and — the half that
 * matters just as much — when it is not.
 *
 * A directive that fired on every topic would teach the model to nest three
 * bullets that read better flat, which is its own defect and the reason the
 * control case here is not an afterthought.
 */
import { describe, expect, test } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import { NOTES_AUTHOR_ID } from '../src/notes-doc-access.ts';
import { MAX_FLAT_RUN_BULLETS } from '../src/notes-quality.ts';
import { regroupDirective } from '../src/notes-regroup-ask.ts';
import {
  MAX_TOPIC_NOTES,
  homelessRun,
  overgrownTopics,
  regroupTargets,
} from '../src/notes-regroup.ts';
import { bullet, bullets, heading, ownHeading } from './notes-regroup-fixtures.ts';
describe('regroupTargets', () => {
  test(`names a topic that has reached ${MAX_FLAT_RUN_BULLETS} flat bullets`, () => {
    const topic = heading('Remote control usability');
    const targets = regroupTargets([topic, ...bullets(MAX_FLAT_RUN_BULLETS)], {
      author: NOTES_AUTHOR_ID,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]?.heading).toBe('Remote control usability');
    expect(targets[0]?.headingId).toBe(topic.id);
    expect(targets[0]?.runLength).toBe(MAX_FLAT_RUN_BULLETS);
    expect(targets[0]?.movable.map((b) => b.text)).toEqual([
      'point 1',
      'point 2',
      'point 3',
      'point 4',
    ]);
  });

  test('says nothing about a short topic — the control', () => {
    const targets = regroupTargets(
      [heading('One quick subject'), ...bullets(MAX_FLAT_RUN_BULLETS - 1)],
      { author: NOTES_AUTHOR_ID },
    );
    expect(targets).toEqual([]);
  });

  test('says nothing once the topic has been grouped', () => {
    // The same five points, two of them now nested under the first. The bar
    // reads this as runs of 1 and 2, so nothing here is a wall any more.
    const grouped = [
      heading('Remote control usability'),
      bullet('lead'),
      bullet('sub one', { depth: 1 }),
      bullet('sub two', { depth: 1 }),
      bullet('still flat'),
      bullet('also flat'),
    ];
    expect(regroupTargets(grouped, { author: NOTES_AUTHOR_ID })).toEqual([]);
  });

  test('counts a run per topic, not per document', () => {
    const targets = regroupTargets(
      [
        heading('First topic'),
        ...bullets(MAX_FLAT_RUN_BULLETS, 'a'),
        heading('Second topic'),
        ...bullets(MAX_FLAT_RUN_BULLETS - 1, 'b'),
      ],
      { author: NOTES_AUTHOR_ID },
    );
    expect(targets.map((t) => t.heading)).toEqual(['First topic']);
  });

  test("counts a person's bullet in the run but never offers to move it", () => {
    const targets = regroupTargets(
      [
        heading('Remote control usability'),
        bullet('ours one'),
        bullet('theirs', { theirs: true }),
        bullet('ours two'),
        bullet('ours three'),
      ],
      { author: NOTES_AUTHOR_ID },
    );
    expect(targets[0]?.runLength).toBe(MAX_FLAT_RUN_BULLETS);
    expect(targets[0]?.movable.map((b) => b.text)).toEqual(['ours one', 'ours two', 'ours three']);
  });

  test("stays quiet when only one bullet of the run is the note-taker's", () => {
    // One movable bullet cannot become a group, so an instruction to regroup
    // would have no legal answer.
    const targets = regroupTargets(
      [
        heading('Remote control usability'),
        bullet('ours'),
        bullet('theirs one', { theirs: true }),
        bullet('theirs two', { theirs: true }),
        bullet('theirs three', { theirs: true }),
      ],
      { author: NOTES_AUTHOR_ID },
    );
    expect(targets).toEqual([]);
  });

  test("reads only this meeting's section when it has one", () => {
    const notes = heading("Today's meeting notes", 2);
    const targets = regroupTargets(
      [
        heading('Something the doc already had', 2),
        ...bullets(MAX_FLAT_RUN_BULLETS + 2, 'old'),
        notes,
        heading('A topic', 3),
        ...bullets(MAX_FLAT_RUN_BULLETS - 1, 'new'),
      ],
      { author: NOTES_AUTHOR_ID, notesHeadingId: notes.id },
    );
    expect(targets).toEqual([]);
  });

  test('never offers to group a run that sits above every heading', () => {
    // A homeless wall wants a heading, not a group, and the prompt asks for
    // one elsewhere. Firing here taught the note-taker to nest instead of
    // opening `### `, and cost the "organised under topics" bar outright.
    const targets = regroupTargets([...bullets(MAX_FLAT_RUN_BULLETS + 3, 'homeless')], {
      author: NOTES_AUTHOR_ID,
    });
    expect(targets).toEqual([]);
  });

  test('a run before the first heading is silent while the one after it is named', () => {
    const topic = heading('A named topic');
    const targets = regroupTargets(
      [...bullets(MAX_FLAT_RUN_BULLETS, 'homeless'), topic, ...bullets(MAX_FLAT_RUN_BULLETS, 'x')],
      { author: NOTES_AUTHOR_ID },
    );
    expect(targets.map((t) => t.headingId)).toEqual([topic.id]);
  });

  test('a paragraph note between bullets does not break the run, and counts in it', () => {
    const targets = regroupTargets(
      [
        heading('Remote control usability'),
        ...bullets(2, 'a'),
        { id: 'p1', kind: 'block', nodeName: 'paragraph', text: 'a stray paragraph' },
        ...bullets(2, 'b'),
      ],
      { author: NOTES_AUTHOR_ID },
    );
    expect(targets[0]?.runLength).toBe(MAX_FLAT_RUN_BULLETS + 1);
  });
});

describe('homelessRun', () => {
  test('names the run above every heading once it has reached the bar', () => {
    const run = bullets(MAX_FLAT_RUN_BULLETS, 'homeless');
    const found = homelessRun(run, { author: NOTES_AUTHOR_ID });
    expect(found?.runLength).toBe(MAX_FLAT_RUN_BULLETS);
    expect(found?.bullets.map((b) => b.id)).toEqual(run.map((b) => b.id));
  });

  test('is null while that run is still short — the control', () => {
    expect(
      homelessRun(bullets(MAX_FLAT_RUN_BULLETS - 1, 'homeless'), { author: NOTES_AUTHOR_ID }),
    ).toBeNull();
  });

  test('is null once a heading stands over the notes', () => {
    expect(
      homelessRun([heading('A topic'), ...bullets(MAX_FLAT_RUN_BULLETS + 2)], {
        author: NOTES_AUTHOR_ID,
      }),
    ).toBeNull();
  });
});

describe("the meeting's own section", () => {
  test('names the run under the section heading itself, rather than calling it homeless', () => {
    const own = ownHeading('Harborlight survey');
    const outline = [own, ...bullets(MAX_FLAT_RUN_BULLETS, 'point')];
    const opts = { author: NOTES_AUTHOR_ID, notesHeadingId: own.id };
    expect(regroupTargets(outline, opts).map((t) => t.headingId)).toEqual([own.id]);
    // The control, and the bug itself: these bullets have a heading, so
    // nothing may ask the note-taker to open one for them.
    expect(homelessRun(outline, opts)).toBeNull();
    expect(regroupDirective(outline, opts)).not.toContain('UNDER NO HEADING');
  });

  test('follows the meeting into the next topic IT opened', () => {
    const first = ownHeading('Harborlight survey');
    const second = ownHeading('Slipway crane booking');
    const outline = [
      first,
      ...bullets(2, 'early'),
      second,
      ...bullets(MAX_FLAT_RUN_BULLETS, 'later'),
    ];
    const targets = regroupTargets(outline, {
      author: NOTES_AUTHOR_ID,
      notesHeadingId: first.id,
    });
    expect(targets.map((t) => t.heading)).toEqual(['Slipway crane booking']);
  });

  test('stops at a heading the meeting did not write — the control', () => {
    const own = ownHeading('Harborlight survey');
    // Same shape, except the second heading is the document's own: a long
    // list in somebody else's section is not this meeting's wall, and telling
    // the note-taker to reorganise it would be worse than saying nothing.
    const theirs = heading('Standing agenda', 2);
    const outline = [
      own,
      ...bullets(2, 'early'),
      theirs,
      ...bullets(MAX_FLAT_RUN_BULLETS, 'later'),
    ];
    expect(regroupTargets(outline, { author: NOTES_AUTHOR_ID, notesHeadingId: own.id })).toEqual(
      [],
    );
  });
});

describe('overgrownTopics', () => {
  /** A topic already gathered into groups: no flat run anywhere in it, and
   *  still a heading the reader meets a whole stretch of meeting under. */
  function grouped(n: number, under: string): prose.OutlineEntry[] {
    const out: prose.OutlineEntry[] = [];
    for (let i = 0; i < n; i++) {
      out.push(bullet(`${under} lead ${i}`), bullet(`${under} a ${i}`, { depth: 1 }));
      out.push(bullet(`${under} b ${i}`, { depth: 1 }));
    }
    return out;
  }

  test('names a heading past the bar even when nothing under it is flat', () => {
    const own = ownHeading('Slipway crane booking');
    const outline = [own, ...grouped(5, 'crane')];
    const opts = { author: NOTES_AUTHOR_ID, notesHeadingId: own.id };
    // Fifteen notes in five tidy groups: the flat-run bar sees nothing at all.
    expect(regroupTargets(outline, opts)).toEqual([]);
    expect(overgrownTopics(outline, opts).map((t) => t.notes)).toEqual([15]);
  });

  test('is silent one note below the bar — the control', () => {
    const own = ownHeading('Slipway crane booking');
    const outline = [own, ...bullets(MAX_TOPIC_NOTES - 1, 'crane')];
    expect(overgrownTopics(outline, { author: NOTES_AUTHOR_ID, notesHeadingId: own.id })).toEqual(
      [],
    );
  });

  test('names a heading the room has already moved on from, as not live', () => {
    // IT USED TO NAME NOTHING AT ALL HERE, and that is what a thirty-minute
    // replay measured as the defect: on 107 of the 111 ticks that had a topic
    // over the bar, the topic was an earlier one and no ask fired. A topic
    // stops being live the moment a heading opens below it, and every note
    // `insert_under_heading` lands on it after that is one nothing can ever
    // ask about again.
    //
    // WHAT THE `live` FLAG STILL CARRIES is the half of the remedy an earlier
    // heading cannot do: "open the next heading" is about where the NEXT note
    // goes, and asked of an earlier one it repeated every remaining tick and
    // the note-taker opened a heading a tick. The repair half — putting a
    // heading in front of a note already written — is about the page, not
    // about where the room is, so it applies to both.
    const swallowed = ownHeading('Slipway crane booking');
    const now = ownHeading('Budget line');
    const outline = [swallowed, ...bullets(MAX_TOPIC_NOTES, 'crane'), now, ...bullets(1, 'budget')];
    const opts = { author: NOTES_AUTHOR_ID, notesHeadingId: swallowed.id };
    expect(overgrownTopics(outline, opts).map((t) => [t.heading, t.notes, t.live])).toEqual([
      ['Slipway crane booking', MAX_TOPIC_NOTES, false],
    ]);
    // CONTROL: the same heading, still the live one, is named AND live.
    expect(
      overgrownTopics([swallowed, ...bullets(MAX_TOPIC_NOTES, 'crane')], opts).map((t) => [
        t.heading,
        t.live,
      ]),
    ).toEqual([['Slipway crane booking', true]]);
  });

  test('is silent about an earlier heading one note below the bar — the control', () => {
    const swallowed = ownHeading('Slipway crane booking');
    const now = ownHeading('Budget line');
    const outline = [
      swallowed,
      ...bullets(MAX_TOPIC_NOTES - 1, 'crane'),
      now,
      ...bullets(1, 'budget'),
    ];
    expect(
      overgrownTopics(outline, { author: NOTES_AUTHOR_ID, notesHeadingId: swallowed.id }),
    ).toEqual([]);
  });
});
