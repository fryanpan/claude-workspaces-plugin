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
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { NOTES_AUTHOR_ID } from '../src/notes-doc-access.ts';
import { notesTopicHashes } from '../src/notes-heading-level.ts';
import { buildNotesPrompt } from '../src/notes-prompt-build.ts';
import { MAX_FLAT_RUN_BULLETS } from '../src/notes-quality.ts';
import { regroupDirective } from '../src/notes-regroup-ask.ts';
import {
  MAX_TOPIC_NOTES,
  homelessRun,
  overgrownTopics,
  regroupTargets,
} from '../src/notes-regroup.ts';

let seq = 0;
function heading(text: string, level = 3): prose.OutlineEntry {
  return { id: `h${++seq}`, kind: 'heading', nodeName: 'heading', level, text };
}
function bullet(
  text: string,
  opts: { depth?: number; theirs?: boolean; under?: string } = {},
): prose.OutlineEntry {
  return {
    id: `b${++seq}`,
    kind: 'listItem',
    nodeName: 'listItem',
    text,
    depth: opts.depth ?? 0,
    ...(opts.theirs === true ? {} : { author: NOTES_AUTHOR_ID }),
    ...(opts.under !== undefined ? { underHeadingId: opts.under } : {}),
  };
}
function bullets(n: number, prefix = 'point'): prose.OutlineEntry[] {
  return Array.from({ length: n }, (_, i) => bullet(`${prefix} ${i + 1}`));
}

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

describe('regroupDirective', () => {
  test('names the ids and hands over a nest_blocks call to copy', () => {
    const topic = heading('Remote control usability');
    const run = bullets(MAX_FLAT_RUN_BULLETS);
    const text = regroupDirective([topic, ...run], { author: NOTES_AUTHOR_ID });
    expect(text).not.toBeNull();
    expect(text).toContain('Remote control usability');
    for (const b of run) expect(text).toContain(b.id);
    expect(text).toContain(
      `{"op":"nest_blocks","leadBlockId":"${run[0]?.id}","blockIds":["${run[1]?.id}","${run[2]?.id}"]}`,
    );
  });

  test('names only the two topics nearest the live end of a long meeting', () => {
    // Five full topics, the shape a whole-doc outline reaches an hour into a
    // meeting. The directive is the part of the prompt nothing can cache, so
    // it names what this update can act on and nothing else.
    const outline: prose.OutlineEntry[] = [];
    for (let i = 0; i < 5; i++) {
      outline.push(heading(`Topic ${i}`), ...bullets(MAX_FLAT_RUN_BULLETS, `t${i}`));
    }
    const text = regroupDirective(outline, { author: NOTES_AUTHOR_ID }) ?? '';
    expect(text).toContain('Topic 4');
    expect(text).toContain('Topic 3');
    // CONTROL: the earlier topics are just as full — the bar has not changed,
    // only how many of them one update is asked about.
    expect(regroupTargets(outline, { author: NOTES_AUTHOR_ID })).toHaveLength(5);
    expect(text).not.toContain('Topic 2');
    expect(text).not.toContain('Topic 0');
  });

  test('asks a run nobody has named for a heading, never for nesting', () => {
    const run = bullets(MAX_FLAT_RUN_BULLETS + 2, 'homeless');
    const text = regroupDirective(run, { author: NOTES_AUTHOR_ID });
    expect(text).toContain('UNDER NO HEADING');
    // The LEVEL comes from the doc, never from this module: a run with no
    // headings above it is a topic at `## `.
    expect(text).toContain(`${notesTopicHashes(run)} `);
    expect(text).toContain('## ');
    // The remedy for a homeless wall is the heading. Offering to nest as well
    // is what taught the note-taker to nest INSTEAD, and cost the "organised
    // under topics" bar a measured 83% to 0% on ES2002a x ledger-haiku.
    expect(text).not.toContain('nest_blocks');
    for (const b of run) expect(text).toContain(b.id);
  });

  test('asks at the level the DOC uses, not a level this module picked', () => {
    // Same homeless run, but the page it sits on is titled and its topics are
    // `### `-level under a `# ` title, so a topic opened now is `### ` too. A
    // build that hardcoded a level would give the same answer to both docs.
    const run = bullets(MAX_FLAT_RUN_BULLETS + 2, 'homeless');
    const deep = [...run, heading('The page', 1), heading('A topic', 3)];
    const text = regroupDirective(deep, { author: NOTES_AUTHOR_ID }) ?? '';
    expect(text).toContain('### ');
    expect(text).not.toContain('\n## ');
  });

  test('is null on a short run nobody has named — the control', () => {
    expect(
      regroupDirective([...bullets(MAX_FLAT_RUN_BULLETS - 1, 'homeless')], {
        author: NOTES_AUTHOR_ID,
      }),
    ).toBeNull();
  });

  test('asks for the heading before the groups when a doc has both walls', () => {
    const topic = heading('A named topic');
    const text =
      regroupDirective(
        [
          ...bullets(MAX_FLAT_RUN_BULLETS, 'homeless'),
          topic,
          ...bullets(MAX_FLAT_RUN_BULLETS, 'named'),
        ],
        { author: NOTES_AUTHOR_ID },
      ) ?? '';
    expect(text.indexOf('UNDER NO HEADING')).toBeLessThan(text.indexOf('THESE TOPICS ARE FULL'));
  });

  test('is null on a short topic, so a quiet tick pays nothing for it', () => {
    expect(
      regroupDirective([heading('One quick subject'), ...bullets(2)], { author: NOTES_AUTHOR_ID }),
    ).toBeNull();
  });
});

/* ===== The prompt the composer actually sends ===== */

function composeInput(outline: prose.OutlineEntry[]): NotesComposeInput {
  return {
    outline,
    tick: {
      reason: 'pause',
      turns: [{ speaker: 'Dana', speakerLabel: 'B', text: 'and one more thing' }],
    },
  } as unknown as NotesComposeInput;
}

describe('the tick prompt', () => {
  test('carries the regroup directive once a topic is full', () => {
    const topic = heading('Remote control usability');
    const run = bullets(MAX_FLAT_RUN_BULLETS);
    const { user } = buildNotesPrompt(composeInput([topic, ...run]));
    expect(user).toContain('GROUP THEM IN THIS UPDATE');
    expect(user).toContain(run[0]?.id as string);
  });

  test('carries nothing extra while every topic is short — the control', () => {
    const short = [heading('One quick subject'), ...bullets(MAX_FLAT_RUN_BULLETS - 1)];
    const { user } = buildNotesPrompt(composeInput(short));
    expect(user).not.toContain('GROUP THEM IN THIS UPDATE');
    expect(user).not.toContain('nest_blocks');
  });

  test('asks a wall with no heading for the heading, not for groups', () => {
    const homeless = bullets(MAX_FLAT_RUN_BULLETS + 2, 'homeless');
    const { user } = buildNotesPrompt(composeInput(homeless));
    expect(user).toContain('UNDER NO HEADING');
    expect(user).not.toContain('GROUP THEM IN THIS UPDATE');
  });

  test('carries nothing extra while the notes are still short — the control', () => {
    const { user } = buildNotesPrompt(composeInput(bullets(MAX_FLAT_RUN_BULLETS - 1, 'early')));
    expect(user).not.toContain('UNDER NO HEADING');
    expect(user).not.toContain('GROUP THEM IN THIS UPDATE');
  });

  test('shows a nested point as a sub-bullet so a group can be told from a wall', () => {
    const { user } = buildNotesPrompt(
      composeInput([heading('A topic'), bullet('lead'), bullet('nested', { depth: 1 })]),
    );
    const lines = user.split('\n');
    expect(lines.find((l) => l.endsWith('| lead'))).toContain(' bullet ');
    expect(lines.find((l) => l.endsWith('| nested'))).toContain(' sub-bullet ');
  });
});

/* ===== The meeting's own notes, all of them (2026-09-16) ===== */

/**
 * A live meeting's section heading is the one the note-taker is writing under
 * RIGHT NOW, and the scan used to begin one block after it — so the first
 * topic of every meeting read as a wall with no heading over it, and the
 * meeting's second topic ended the scope outright. Every case here is about
 * the scoped path, which is the path production takes and the one no test
 * reached.
 */
function ownHeading(text: string, level = 2): prose.OutlineEntry {
  return {
    id: `h${++seq}`,
    kind: 'heading',
    nodeName: 'heading',
    level,
    text,
    author: NOTES_AUTHOR_ID,
  };
}

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

  test('says nothing about a heading the room has already moved on from', () => {
    // The ask is "open the NEXT heading", which only the heading this speech
    // is landing under can carry out. Asked of an earlier one it repeats every
    // remaining tick and the note-taker opens a heading a tick.
    const swallowed = ownHeading('Slipway crane booking');
    const now = ownHeading('Budget line');
    const outline = [swallowed, ...bullets(MAX_TOPIC_NOTES, 'crane'), now, ...bullets(1, 'budget')];
    const opts = { author: NOTES_AUTHOR_ID, notesHeadingId: swallowed.id };
    expect(overgrownTopics(outline, opts)).toEqual([]);
    // CONTROL: the same heading, still the live one, is named.
    expect(
      overgrownTopics([swallowed, ...bullets(MAX_TOPIC_NOTES, 'crane')], opts).map(
        (t) => t.heading,
      ),
    ).toEqual(['Slipway crane booking']);
  });
});

describe('the three remedies', () => {
  test('asks a swallowed topic for the next heading, and not for a group', () => {
    const own = ownHeading('Slipway crane booking');
    const text =
      regroupDirective([own, ...bullets(MAX_TOPIC_NOTES, 'crane')], {
        author: NOTES_AUTHOR_ID,
        notesHeadingId: own.id,
      }) ?? '';
    expect(text).toContain('HAS RUN PAST ONE HEADING');
    expect(text).toContain(own.id);
    // Both other remedies, spelled at the levels THIS doc writes at.
    expect(text).toContain('### ');
    expect(text).toContain('## ');
    // Nesting is the remedy it is being told not to reach for.
    expect(text).not.toContain('GROUP THEM IN THIS UPDATE');
  });

  test('asks a topic that is merely full for a group — the control', () => {
    const own = ownHeading('Harborlight survey');
    const text =
      regroupDirective([own, ...bullets(MAX_FLAT_RUN_BULLETS, 'point')], {
        author: NOTES_AUTHOR_ID,
        notesHeadingId: own.id,
      }) ?? '';
    expect(text).toContain('GROUP THEM IN THIS UPDATE');
    expect(text).not.toContain('HAS RUN PAST ONE HEADING');
  });

  test("the group ask no longer trades this speech's note for the grouping", () => {
    // It used to say "Do NOT add another bullet". An obedient note-taker then
    // spent a tick in five on structure and wrote nothing for the speech that
    // tick — fourteen notes of seventy, measured in notes-long-topic.test.ts.
    const own = ownHeading('Harborlight survey');
    const text =
      regroupDirective([own, ...bullets(MAX_FLAT_RUN_BULLETS, 'point')], {
        author: NOTES_AUTHOR_ID,
        notesHeadingId: own.id,
      }) ?? '';
    expect(text).toContain('Keep every idea');
    expect(text).not.toContain('Do NOT add another bullet');
  });
});
