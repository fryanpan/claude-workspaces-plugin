/**
 * The WORDS a regroup is asked in — the rendering half, tested apart from the
 * counting half for the same reason the modules are apart: what the scan
 * decides is arithmetic, and what this decides is what a model reads.
 */
import { describe, expect, test } from 'bun:test';
import type { prose } from '@claude-workspaces/core';
import { NOTES_AUTHOR_ID } from '../src/notes-doc-access.ts';
import { notesTopicHashes } from '../src/notes-heading-level.ts';
import { buildNotesPrompt } from '../src/notes-prompt-build.ts';
import { MAX_FLAT_RUN_BULLETS } from '../src/notes-quality.ts';
import { regroupDirective } from '../src/notes-regroup-ask.ts';
import { MAX_TOPIC_NOTES, regroupTargets } from '../src/notes-regroup.ts';
import { bullet, bullets, composeInput, heading, ownHeading } from './notes-regroup-fixtures.ts';

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

describe('the three remedies', () => {
  test('asks a swallowed topic to break the stretch, and to place the heading', () => {
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
    // AND THE OP THAT PLACES IT. Without this line the ask names a shape the
    // edits cannot reach: every other insert lands at an end, so the heading
    // would arrive under the stretch it is meant to head.
    expect(text).toContain('insert_before_block');
  });

  test('asks that topic for the group as well, because the two compose now', () => {
    const own = ownHeading('Slipway crane booking');
    const text =
      regroupDirective([own, ...bullets(MAX_TOPIC_NOTES, 'crane')], {
        author: NOTES_AUTHOR_ID,
        notesHeadingId: own.id,
      }) ?? '';
    // IT USED TO SAY "do NOT nest these", and that was right for as long as a
    // heading could only be APPENDED: the ask was then "stop adding here",
    // and grouping what was already written was its opposite. Placement makes
    // the split a repair instead, so both remedies apply to the same topic.
    // Asked for the split alone, a repaired meeting ended with a flat run of
    // `MAX_TOPIC_NOTES` under its live heading and no ask ever firing on it —
    // measured in `notes-long-topic.test.ts`.
    expect(text).toContain('GROUP THEM IN THIS UPDATE');
    expect(text).not.toContain('do NOT nest these');
  });

  test('asks a topic that is merely full for a group — the control', () => {
    const own = ownHeading('Harborlight survey');
    const text =
      regroupDirective([own, ...bullets(MAX_FLAT_RUN_BULLETS, 'point')], {
        author: NOTES_AUTHOR_ID,
        notesHeadingId: own.id,
      }) ?? '';
    expect(text).toContain('GROUP THEM IN THIS UPDATE');
    // CONTROL FOR THE PAIR ABOVE: a topic below the per-heading bar is asked
    // for the group and NOT for a split, so the two asks are still decided
    // separately — composing them did not collapse them into one.
    expect(text).not.toContain('HAS RUN PAST ONE HEADING');
    expect(text).not.toContain('insert_before_block');
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
