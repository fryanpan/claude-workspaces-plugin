/**
 * What the note-taker is now asked to do, and what the pipeline around it
 * guarantees whatever the model returns.
 *
 * The behaviour has two halves and they are tested differently on purpose.
 *
 * The PROMPT half — paraphrase, twenty words, mark a guess, cover what was
 * decided — is instruction, and no unit test can prove a model followed an
 * instruction. What is asserted here is that the instruction reaches the
 * model on every tick, which is the part that can silently stop being true.
 * Whether it is FOLLOWED is `bun run notes:eval`, against real meetings.
 *
 * The PIPELINE half is structural and is asserted properly: a person's line
 * survives a tick that tried to rewrite it, a topic already in the notes does
 * not get a second heading, and a row this tick's speech named arrives at the
 * composer with its URL.
 *
 * WHAT THE REBUILD MOVED OUT OF THE PROMPT. Several rules here used to be
 * words — "leave their lines at the top level", "move a person's line but
 * never rewrite one" — because the model was handed the whole notes and could
 * physically return a rewritten version of anybody's line. It no longer can:
 * it answers with edits addressed to block ids, and an edit naming a block the
 * note-taker does not own becomes a SUGGESTION in the doc rather than a write.
 * So those assertions moved from "the prompt says so" to "the doc does so",
 * which is the stronger test and the reason the guarantee no longer depends on
 * a model reading a paragraph.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { prose } from '@claude-workspaces/core';
import type * as Y from 'yjs';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { buildNotesPrompt } from '../src/notes-prompt-build.ts';
import {
  MAX_BULLET_WORDS,
  MAX_FLAT_RUN_BULLETS,
  allBullets,
  duplicateTopics,
  parseNotesTopics,
} from '../src/notes-quality.ts';
import { asPerson, findSectionSpan } from './notes-doc-helpers.ts';
import { addNotes, createNotesTickHarness } from './notes-tick-harness.ts';
import type { TickSnapshot } from './notes-tick-harness.ts';

/**
 * The compose input for a tick that definitely composed.
 *
 * `TickSnapshot.input` is optional because a coalesced or skipped tick has
 * none. Every tick in this file drives a compose, so absence here is a broken
 * test rather than a case to handle — and saying so out loud beats the cast
 * that used to live in the harness and crashed the eval instead of failing.
 */
const composeInput = (shot: TickSnapshot): NotesComposeInput => {
  if (!shot.input) throw new Error(`tick ${shot.tick} never reached the composer`);
  return shot.input;
};

const emptyInput: NotesComposeInput = {
  docId: 'd1',
  meetingId: 'm1',
  tick: { tick: 1, reason: 'pause', turns: [{ turn: 0, text: 'We should measure first.' }] },
  outline: [],
};

/* ===== The instruction reaches the model ===== */

describe('the notetaking instructions', () => {
  const system = buildNotesPrompt(emptyInput).system;

  it('ask for paraphrase rather than a transcript with headings', () => {
    expect(system).toMatch(/Paraphrase/);
    expect(system).toMatch(/transcript with/i);
  });

  it('state the twenty-word bar the eval measures', () => {
    expect(system).toContain(`AT MOST ${MAX_BULLET_WORDS} WORDS`);
  });

  it('ask for list items, which is what the model does not do unprompted', () => {
    // Measured, not guessed. Run against real AMI speech, the instructions
    // without this rule came back as PARAGRAPHS under the topic headings —
    // good content, well organised, and not a set of notes: every
    // bullet-shaped check downstream read zero bullets, and a reader cannot
    // point at a line that is not a line. Naming the markdown is the fix.
    expect(system).toContain('MARKDOWN LIST ITEM');
    expect(system).toMatch(/beginning with[\s\S]{0,40}"- "/);
  });

  it('say that ideas are never dropped, only compressed', () => {
    // The rule this replaced ended "fewer, better notes beat complete ones",
    // which told the note-taker that leaving an idea out was a success. A
    // minute of real conversation then produced no note at all.
    expect(system).toContain('COMPRESS, NEVER DROP');
    expect(system).not.toMatch(/fewer, better notes/i);
    expect(system).toMatch(/every idea/i);
  });

  it('put no ceiling on how many edits one tick may write', () => {
    // The rule this replaced said "two or three edits is a normal tick",
    // which is a cap on how much a tick may RECORD and so a licence to drop
    // whatever a busy minute raised past the third idea. Lifting it moved the
    // longest AMI meeting from 57.3% of ideas in no note to 46.8%.
    expect(system).toContain('WRITE ONE EDIT PER IDEA');
    expect(system).toMatch(/no ceiling/i);
    expect(system).not.toMatch(/edits is a normal tick/i);
  });

  it('open a heading as soon as a subject has nowhere to go', () => {
    // Headings used to wait until the discussion had "genuinely moved to a
    // different topic", which leaves an idea about a new subject with no
    // heading to sit under — and an idea with nowhere to go is dropped.
    expect(system).toMatch(/heading is cheap/i);
    expect(system).not.toMatch(/genuinely moved to a different topic/i);
  });

  it('give open questions one fixed heading rather than a good place', () => {
    // Both halves, and they are different rules: the FLOOR says a topic is
    // not finished until what is open is written down, and HOW TO ORGANISE
    // says where. Asserting only the heading text passed with the organising
    // rule deleted, because the floor bullet quotes the same heading — an
    // assertion that could not fail on the behaviour it named.
    expect(system).toContain('### Open questions');
    expect(system).toContain('ONE HEADING IS FIXED');
  });

  it('name the floor a finished topic has to reach', () => {
    for (const asked of [
      'what was discussed',
      'what it means and why it matters',
      'what was decided, and by whom',
      'what happens next, and who owns it',
      '(unconfirmed)',
    ]) {
      expect(system).toContain(asked);
    }
  });

  it('name the four things a note should carry', () => {
    for (const asked of ['discussed', 'why it matters', 'decided', 'happens next']) {
      expect(system).toContain(asked);
    }
  });

  it('offer a missed sentence back as a second look, not as new speech', () => {
    const withMissed = buildNotesPrompt({
      ...emptyInput,
      missed: [{ turn: 0, text: 'The export dialog forgets the range.', speaker: 'Devi' }],
    }).user;
    expect(withMissed).toContain('STILL IN NO NOTE');
    expect(withMissed).toContain('The export dialog forgets the range.');
    // And a tick with nothing outstanding is not told about a section that
    // does not apply to it.
    expect(buildNotesPrompt(emptyInput).user).not.toContain('STILL IN NO NOTE');
  });

  it('ask for topic headings that are reused rather than reopened', () => {
    expect(system).toMatch(/### /);
    expect(system).toMatch(/never open a second heading/i);
  });

  it('ask for a guess to be marked rather than dropped or asserted', () => {
    expect(system).toContain('(unconfirmed)');
  });

  it('keep a decision and an open question attributed', () => {
    expect(system).toMatch(/DECISION AND AN OPEN QUESTION ALWAYS KEEP THEIR SPEAKER TAG/);
  });

  it('ask for the answer as edits addressed to block ids, not as prose', () => {
    // The whole contract in one instruction. A model that answers with the
    // notes as markdown composes nothing at all now (`readNotesEdits` throws),
    // so this sentence is load-bearing rather than stylistic.
    expect(system).toContain('JSON array of EDITS');
    expect(system).toMatch(/Never return prose/);
    for (const op of ['insert_under_heading', 'insert_at_end', 'replace_block', 'delete_block']) {
      expect(system).toContain(op);
    }
  });

  it('let the note-taker revise its OWN bullet rather than contradict it', () => {
    // The rule that shipped before this said the opposite — new material at
    // the end, "never to restructure notes the new speech does not touch".
    expect(system).toMatch(/overturns or corrects a bullet of YOURS, replace_block/);
    expect(system).not.toMatch(/never to restructure/);
  });

  it("say that a person's block may be proposed to, never rewritten", () => {
    expect(system).toContain('ONLY EDIT A BLOCK MARKED "yours"');
    expect(system).toMatch(/reaches them as a\s+suggestion/);
  });

  it('ask for a topic past the bar to be regrouped, by grouping not dropping', () => {
    expect(system).toContain(`More than ${MAX_FLAT_RUN_BULLETS} bullets under one heading`);
    // Named as the op, not described as a shape: the regroup is a move, and a
    // model told only what the result should look like reaches for
    // replace_block plus delete_block, which retypes every folded point.
    expect(system).toContain('nest_blocks');
    expect(system).toMatch(/nest_blocks MOVES bullets/);
    // Grouping, not deleting. An earlier revision passed the bar by dropping a
    // point to get under the number, which trades a wall for a note nobody
    // wrote.
    expect(system).toMatch(/GROUPING, never\s+by dropping a point/);
  });
});

/* ===== References: the search reaches the prompt with URLs ===== */

describe('a board row this tick named', () => {
  it('reaches the composer as a link it is told to cite', () => {
    const prompt = buildNotesPrompt({
      ...emptyInput,
      references: [
        { kind: 'task', title: 'Retry loop wakes the sync', url: '/workspaces/w-1?task=t-3' },
        { kind: 'doc', title: 'Last Tuesday', url: '/workspaces/w-1/docs/d-9', when: '2026-08-25' },
      ],
    });
    expect(prompt.user).toContain('[Retry loop wakes the sync](/workspaces/w-1?task=t-3)');
    expect(prompt.user).toContain('[Last Tuesday](/workspaces/w-1/docs/d-9)');
    expect(prompt.user).toContain('met 2026-08-25');
    expect(prompt.user).toMatch(/write its name as a markdown link/);
  });

  it('says nothing at all on a tick that named nothing', () => {
    expect(buildNotesPrompt(emptyInput).user).not.toMatch(/already on the board/);
  });

  it('is found from the board and handed to the compose, end to end', async () => {
    const harness = createNotesTickHarness({
      workspaceId: 'w-1',
      tasks: [
        { id: 't-3', title: 'Retry loop wakes the sync every ninety seconds', status: 'todo' },
        { id: 't-4', title: 'Lantern badge counts stale invites', status: 'todo' },
      ],
      boardDocs: [{ docId: 'd-9', title: 'Backoff design note', meetingAt: Date.UTC(2026, 7, 25) }],
      compose: (input) => addNotes(input, '- A note.'),
    });
    const shot = await harness.speak({
      speaker: 'A',
      text: 'The retry loop wakes the sync every ninety seconds, per the backoff design note.',
    });
    await harness.end();

    const cited = (composeInput(shot).references ?? []).map((r) => r.title);
    expect(cited).toContain('Retry loop wakes the sync every ninety seconds');
    expect(cited).toContain('Backoff design note');
    // The row nobody said stays off the prompt: that is the whole point of
    // searching rather than listing.
    expect(cited).not.toContain('Lantern badge counts stale invites');
    expect(composeInput(shot).references?.[0]?.url).toBe('/workspaces/w-1?task=t-3');
  });

  it('is absent when the doc belongs to no board', async () => {
    const harness = createNotesTickHarness({
      tasks: [
        { id: 't-3', title: 'Retry loop wakes the sync every ninety seconds', status: 'todo' },
      ],
      compose: (input) => addNotes(input, '- A note.'),
    });
    const shot = await harness.speak('The retry loop wakes the sync every ninety seconds.');
    await harness.end();
    expect(composeInput(shot).references ?? []).toEqual([]);
  });
});

/* ===== Topics: the same topic keeps one heading ===== */

describe('topic headings across a sequence of ticks', () => {
  /** The id of the topic heading reading `text`, from what the tick was shown.
   *  Null before any tick has opened it. */
  const topicId = (input: NotesComposeInput, text: string): string | undefined =>
    input.outline.find((e) => e.kind === 'heading' && e.text === text)?.id;

  it('stay single when the note-taker keeps writing under one', async () => {
    // The script opens a topic once and then addresses it BY ID, which is the
    // behaviour the block contract buys: there is no way to express "a second
    // heading with the same words" by accident, because a bullet goes under an
    // id rather than under a name that has to be matched.
    const harness = createNotesTickHarness({
      compose: (input, tick) => {
        const sync = topicId(input, 'Sync wakes too often');
        if (sync === undefined) {
          return addNotes(
            input,
            '### Sync wakes too often\n\n- The sync wakes on a ninety-second retry loop.',
          );
        }
        if (tick === 2) {
          return [
            {
              op: 'insert_under_heading',
              headingId: sync,
              markdown: '- Cause: the backoff never resets after a success.',
            },
          ];
        }
        return addNotes(input, '### Export range\n\n- The dialog forgets the range.');
      },
    });
    await harness.speak('The sync wakes every ninety seconds.');
    await harness.speak('That is the backoff not resetting.');
    const third = await harness.speak('Separately, the export dialog forgets the range.');
    await harness.end();

    expect(harness.countHeadings('Meeting notes')).toBe(1);
    expect(duplicateTopics(third.notes)).toEqual([]);
    expect(parseNotesTopics(third.notes).map((t) => t.heading)).toEqual([
      'Sync wakes too often',
      'Export range',
    ]);
    expect(harness.errors).toEqual([]);
  });

  it('let a later tick move a bullet under the topic it belongs to', async () => {
    // The behaviour that shipped before forbade exactly this: new material at
    // the end, and no restructuring the new speech did not touch. Expressed as
    // edits it is a replace of the note-taker's own bullet, which the doc
    // accepts because it still owns it.
    const harness = createNotesTickHarness({
      compose: (input, tick) => {
        if (tick === 1) {
          return addNotes(
            input,
            '- The sync wakes every ninety seconds.\n- The export dialog forgets the range.',
          );
        }
        const stray = input.outline.find(
          (e) => e.author !== undefined && e.text.includes('forgets the range'),
        );
        return [
          ...addNotes(input, '### Sync\n\n- Cause: the backoff never resets.'),
          ...(stray === undefined ? [] : ([{ op: 'delete_block', blockId: stray.id }] as const)),
        ];
      },
    });
    await harness.speak('The sync wakes every ninety seconds. The export dialog forgets.');
    const second = await harness.speak('The backoff never resets after a success.');
    await harness.end();

    const bullets = allBullets(second.notes);
    // Moved, not duplicated: each point appears once.
    expect(bullets.filter((b) => b.includes('ninety seconds'))).toHaveLength(1);
    expect(bullets.filter((b) => b.includes('forgets the range'))).toHaveLength(0);
    expect(bullets.filter((b) => b.includes('backoff never resets'))).toHaveLength(1);
    expect(harness.errors).toEqual([]);
  });
});

/* ===== Consensus: a person's bullet is never edited ===== */

/**
 * A person typing a line into the meeting's own notes section, after the
 * note-taker has opened it.
 *
 * WHY NOT A DOC FIXTURE. A `## Meeting notes` heading already in the doc is
 * not this meeting's section — the session opens its own and remembers ITS id,
 * which is the rule that makes a rename a non-event and a restart additive. So
 * a person's line has to be typed into the section the meeting actually
 * opened, which is what happens in the room anyway.
 */
function typeInNotes(ydoc: Y.Doc, line: string): void {
  const fragment = prose.getProseFragment(ydoc);
  const span = findSectionSpan(fragment, 'Meeting notes');
  if (!span) throw new Error('no notes section to type in');
  asPerson(ydoc, () => {
    fragment.insert(span.endExclusive, prose.parseMarkdownBlocks(`- ${line}`));
  });
}

describe('a bullet a person wrote', () => {
  const humanLine = 'I think this predates the 0.4 rollout';

  it('survives a tick whose compose tried to replace it', async () => {
    // THIS IS THE GUARANTEE, and it is no longer a sentence in a prompt. The
    // script asks, in so many words, to overwrite the block a person typed —
    // the doc refuses, files the rewrite as a suggestion, and the accepted
    // text still reads what they wrote.
    let asked = false;
    const harness = createNotesTickHarness({
      compose: (input, tick) => {
        if (tick === 1) return addNotes(input, '- The sync wakes every ninety seconds.');
        const theirs = input.outline.find(
          (e) => e.author === undefined && e.text.includes('predates'),
        );
        if (theirs === undefined) throw new Error('their line was not in the outline');
        asked = true;
        return [
          { op: 'replace_block', blockId: theirs.id, markdown: '- This postdates the 0.4 rollout' },
        ];
      },
    });
    await harness.speak('The sync wakes every ninety seconds.');
    typeInNotes(harness.ydoc, humanLine);
    const second = await harness.speak('It started after the rollout, I think.');
    await harness.end();

    // The compose really did try — an assertion that passed because the model
    // was never asked would prove nothing.
    expect(asked).toBe(true);
    // The ACCEPTED text — what serializes to disk and what the doc reads —
    // still says what the person typed, once.
    expect(second.notes).toContain(humanLine);
    expect(allBullets(second.notes).filter((b) => b.includes('predates'))).toHaveLength(1);
    expect(harness.errors).toEqual([]);
  });

  it('is shown to the compose as theirs, and as their own words', async () => {
    const seen: NotesComposeInput[] = [];
    const harness = createNotesTickHarness({
      compose: (input) => {
        seen.push(input);
        return addNotes(input, '- A note.');
      },
    });
    await harness.speak('First words.');
    typeInNotes(harness.ydoc, humanLine);
    await harness.speak('More words.');
    await harness.end();

    const input = seen[1] as NotesComposeInput;
    // Derived from the outline rather than tracked on the side: a block with
    // no author is a block no agent owns.
    expect(input.humanNotes).toContain(humanLine);
    expect(input.outline.find((e) => e.text.includes('predates'))?.author).toBeUndefined();
    expect(buildNotesPrompt(input).user).toContain('theirs under=');
    expect(buildNotesPrompt(input).user).toContain(humanLine);
  });

  it('is not duplicated by a tick that writes around it', async () => {
    const harness = createNotesTickHarness({
      compose: (input, tick) =>
        tick === 1
          ? addNotes(input, '- The sync wakes every ninety seconds.')
          : addNotes(input, '### Rollout\n\n- The rollout landed in March.'),
    });
    await harness.speak('The sync wakes every ninety seconds.');
    typeInNotes(harness.ydoc, humanLine);
    const second = await harness.speak('About the rollout.');
    await harness.end();
    expect(allBullets(second.notes).filter((b) => b.includes('predates'))).toHaveLength(1);
    expect(harness.countHeadings('Meeting notes')).toBe(1);
  });
});
