/**
 * What one tick asks the model: the delta, the doc as addressable blocks, the
 * project context, and the ORDER those are put in — which is not a matter of
 * taste, because the cache breakpoint is taken on a prefix.
 *
 * These used to live in `meeting-notes-composer.test.ts` and came out with
 * the module they test. The suite left behind is about the HTTP seam.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { buildNotesPrompt } from '../src/notes-prompt-build.ts';
import { input } from './notes-compose-input.ts';

/** `input`'s doc, grown to `n` bullets under its heading — a meeting long
 *  enough that the outline has a settled part as well as a live end. */
function withBullets(n: number): NotesComposeInput {
  return {
    ...input,
    outline: [
      input.outline[0] as (typeof input.outline)[number],
      ...Array.from({ length: n }, (_, i) => ({
        id: `b${i}`,
        kind: 'listItem' as const,
        nodeName: 'listItem',
        text: `point ${i}`,
        author: 'meeting-notes',
        underHeadingId: 'h1',
      })),
    ],
  };
}

describe('notes prompt', () => {
  it('carries the delta, the doc as addressable blocks, and the project context', () => {
    const { system, user } = buildNotesPrompt(input);
    expect(system).toContain('insert_under_heading');
    for (const turn of input.tick.turns) expect(user).toContain(turn.text);
    // The block table, not the notes as prose: an id, its kind, whose it is.
    expect(user).toContain('b1 bullet yours under=h1 | earlier point');
    expect(user).toContain('h1 h2 yours | Meeting notes');
    expect(user).toContain('Q3 planning');
    expect(user).toContain('Bryan can hear his meeting become notes');
    expect(user).toContain('/repo/planning');
  });

  it('marks the rest of a sentence whose earlier words are already noted', () => {
    // A ceiling tick hands over as much of a long turn as the engine has
    // committed to; the remainder arrives on a later tick. Unmarked it reads
    // as a new thought, and the note-taker opens a second point for the
    // second half of one sentence.
    const { user } = buildNotesPrompt({
      ...input,
      tick: {
        tick: 3,
        reason: 'pause',
        turns: [{ turn: 4, text: 'path first.', continued: true }],
      },
    });
    expect(user).toContain('- path first. [continues a sentence already in the notes]');
  });

  it('says WHY a fragment is a fragment: still being said, or the recording stopped', () => {
    // One string used to serve both, because only the final tick could carry
    // a fragment. A ceiling tick carries them mid-meeting now, and telling
    // the composer the recording stopped while the meeting is still going is
    // telling it something false.
    const mid = buildNotesPrompt({
      ...input,
      tick: {
        tick: 3,
        reason: 'cadence',
        turns: [{ turn: 4, text: 'so the second thing', partial: true }],
      },
    }).user;
    expect(mid).toContain('so the second thing [unfinished — they are still saying it]');
    expect(mid).not.toContain('the recording stopped');

    const stopped = buildNotesPrompt({
      ...input,
      tick: {
        tick: 9,
        reason: 'end',
        turns: [{ turn: 4, text: 'and the one thing I still want', partial: true }],
      },
    }).user;
    expect(stopped).toContain(
      'and the one thing I still want [unfinished — the recording stopped mid-sentence]',
    );
    expect(stopped).not.toContain('still saying it');
  });

  it('a turn that is both carried on and unfinished says both, in that order', () => {
    const { user } = buildNotesPrompt({
      ...input,
      tick: {
        tick: 3,
        reason: 'cadence',
        turns: [{ turn: 4, text: 'we should look at', partial: true, continued: true }],
      },
    });
    expect(user).toContain(
      '- we should look at [continues a sentence already in the notes] ' +
        '[unfinished — they are still saying it]',
    );
  });

  it('an ordinary settled turn carries no marker at all', () => {
    // The control: markers must be the exception, or every line carries
    // noise and none of them means anything.
    const { user } = buildNotesPrompt(input);
    expect(user).toContain('- The sync is the bottleneck.\n');
    expect(user).not.toContain('[continues');
    expect(user).not.toContain('[unfinished');
  });

  it('puts everything that repeats before the line the cache is taken on', () => {
    // The cache is a PREFIX match, so this is the whole feature: the head has
    // to hold the material that reads the same next tick — the project
    // context and the doc — and nothing that is about this tick.
    const { system, stable, volatile, user } = buildNotesPrompt(input);
    expect(user).toBe(`${stable}\n\n${volatile}`);
    expect(system).toContain('insert_under_heading');
    // The doc's settled part, in the head. `input` is a two-block doc, which
    // is entirely LIVE, so the doc a head has to hold is a longer one.
    const long = buildNotesPrompt(withBullets(30));
    expect(long.stable).toContain('b0 bullet yours under=h1 | point 0');
    expect(stable).toContain('Q3 planning');
    // This tick's speech, in the tail — and NOT in the head, which is the
    // assertion that fails if the two blocks ever swap back.
    for (const turn of input.tick.turns) {
      expect(volatile).toContain(turn.text);
      expect(stable).not.toContain(turn.text);
    }
  });

  it('the head is byte-identical across two ticks that differ only in the speech', () => {
    // The behaviour a cache hit IS. Two ticks of one meeting, same doc, and
    // the head has to be the same string — not merely similar.
    const first = buildNotesPrompt(input);
    const second = buildNotesPrompt({
      ...input,
      tick: {
        tick: 3,
        reason: 'pause',
        turns: [{ turn: 5, text: 'And the export dialog forgets the range.' }],
      },
    });
    expect(second.stable).toBe(first.stable);
    expect(second.volatile).not.toBe(first.volatile);
  });

  it('the head changes when the doc does, and only by growing at the end', () => {
    // The other half: a note written between two ticks must appear, and must
    // appear AFTER everything the previous head held, or the prefix is gone.
    const before = buildNotesPrompt(withBullets(30));
    const grown = buildNotesPrompt(withBullets(31));
    expect(grown.stable.startsWith(before.stable)).toBe(true);
    // And the new bullet is in the prompt, wherever the cut put it.
    expect(grown.user).toContain('b30 bullet yours under=h1 | point 30');
  });

  it('a revision to the live end of the doc leaves the head alone', () => {
    // WHY THE CUT IS NOT AT THE END OF THE DOC. A note-taker revises the
    // bullet it wrote a moment ago, and measured over 395 consecutive tick
    // pairs of ten prod meetings, 31% of them changed the doc somewhere other
    // than its end. With the cut at the bottom of the table every one of
    // those threw the whole prompt back to full price.
    const before = buildNotesPrompt(withBullets(30));
    const revised = withBullets(30);
    const last = revised.outline[revised.outline.length - 1];
    const after = buildNotesPrompt({
      ...revised,
      outline: [
        ...revised.outline.slice(0, -1),
        { ...(last as (typeof revised.outline)[number]), text: 'point 29, said better' },
      ],
    });
    expect(after.stable).toBe(before.stable);
    // The control: the revision really did reach the prompt. Without this the
    // assertion above would pass on a builder that dropped the block.
    expect(after.user).toContain('point 29, said better');
    expect(after.volatile).not.toBe(before.volatile);
  });

  it('a doc too short to have a settled part is still shown whole', () => {
    // The other control. The cut may never eat the table: a meeting three
    // ticks old has fewer blocks than the live window, and the model has to
    // see all of them.
    const { user, stable, volatile } = buildNotesPrompt(input);
    expect(user).toContain('b1 bullet yours under=h1 | earlier point');
    expect(stable).not.toContain('b1 bullet');
    expect(volatile).toContain('b1 bullet');
  });

  it('names which heading is this meeting’s, so a bullet has an id to go under', () => {
    const { user } = buildNotesPrompt(input);
    expect(user).toContain('notes are under heading h1.');
  });

  it('a block a person has touched reads as theirs, which is what gates a rewrite', () => {
    // `author` is cleared by the doc the moment a person edits a block, so
    // "theirs" is the whole signal the model gets that a rewrite would land
    // as a suggestion. If this line ever rendered "yours" the model would be
    // told it may freely overwrite a person's words.
    const { user } = buildNotesPrompt({
      ...input,
      outline: [{ id: 'b9', kind: 'listItem', nodeName: 'listItem', text: 'my own line' }],
    });
    expect(user).toContain('b9 bullet theirs | my own line');
    expect(user).not.toContain('b9 bullet yours');
  });

  it('asks for a section to be opened when the meeting has none', () => {
    const { user } = buildNotesPrompt({
      ...input,
      outline: [{ id: 'p1', kind: 'block', nodeName: 'paragraph', text: 'agenda' }],
      notesHeadingId: undefined,
    });
    expect(user).toContain('NO notes section');
    expect(user).toContain('## Meeting notes');
  });

  it('an empty doc says so rather than rendering an empty table', () => {
    const { user } = buildNotesPrompt({
      ...input,
      outline: [],
      notesHeadingId: undefined,
      context: undefined,
    });
    expect(user).toContain('The doc is empty');
    expect(user).not.toContain('Project context');
  });

  it('names the speaker on each line when the tick knows one', () => {
    const { system, user } = buildNotesPrompt({
      ...input,
      tick: {
        ...input.tick,
        turns: [
          { turn: 3, text: 'Can you take the migration?', speaker: 'Jordan' },
          { turn: 4, text: 'Sure.', speaker: 'Speaker B' },
          { turn: 5, text: 'Thanks.' },
        ],
      },
    });
    expect(user).toContain('- Jordan: Can you take the migration?');
    expect(user).toContain('- Speaker B: Sure.');
    expect(user).toContain('- Thanks.');
    expect(system).toContain('Speaker B');
  });

  it('carries the LABEL beside the name, and asks for the tag that uses it', () => {
    // The name is what a reader recognises; the label is what a rename can
    // find again. The prompt has to hand over both or the tag it asks for
    // cannot be written.
    const { system, user } = buildNotesPrompt({
      ...input,
      tick: {
        ...input.tick,
        turns: [
          { turn: 3, text: 'Move the gate.', speaker: 'Devi', speakerLabel: 'B' },
          { turn: 4, text: 'Agreed.', speaker: 'Speaker A', speakerLabel: 'A' },
          { turn: 5, text: 'Unattributed.' },
        ],
      },
    });
    expect(user).toContain('- Devi (B): Move the gate.');
    expect(user).toContain('- Speaker A (A): Agreed.');
    expect(user).toContain('- Unattributed.');
    expect(system).toContain('[@Name](speaker:LABEL)');
  });

  it('tells the model a block that is not its own is edited only as a correction', () => {
    const { system } = buildNotesPrompt(input);
    expect(system).toContain('ONLY EDIT A BLOCK MARKED "yours"');
    expect(system).toContain('suggestion');
  });
});

/**
 * A meeting with one voice in it is shown transcript lines carrying no name,
 * and used to be sent instructions demanding a speaker tag on every note —
 * with "Speaker B" spelled out as what such a name looks like. A model asked
 * for a name it has not been given supplies one, which is how a solo huddle
 * came out written as a conversation between Speaker A and Speaker B.
 */
describe('a solo meeting is asked for no attribution at all', () => {
  const solo = { ...input, multiSpeaker: false };

  it('sends no rule demanding a tag, and no spelling for a name', () => {
    const { system } = buildNotesPrompt(solo);
    expect(system).not.toContain('ATTRIBUTE EVERY NOTE');
    expect(system).not.toContain('Speaker B');
    expect(system).not.toContain('speaker:LABEL');
    expect(system).not.toContain('speaker tag');
  });

  it('keeps every rule that is not about who spoke', () => {
    // The block that goes is the attribution block and nothing else: the
    // notes still have to be bullets, still have to cite what they name,
    // and still may only edit their own blocks.
    const { system } = buildNotesPrompt(solo);
    expect(system).toContain('ONLY EDIT A BLOCK MARKED "yours"');
    expect(system).toContain('- Where a note is about a task, doc or earlier meeting');
    expect(system).toContain('ONE POINT PER BULLET');
  });

  it('a multi-speaker tick still gets the rules, byte for byte', () => {
    // The positive control. A gate that removed the block from every prompt
    // would pass the two assertions above and silently stop the notes ever
    // saying who decided anything.
    const both = buildNotesPrompt({ ...input, multiSpeaker: true }).system;
    expect(both).toContain('ATTRIBUTE EVERY NOTE TO THE VOICE THAT SAID IT');
    expect(both).toContain('[@Name](speaker:LABEL)');
    expect(both).toBe(buildNotesPrompt(input).system);
  });
});

describe('captured task links in the prompt', () => {
  it('offers each link and the instruction to cite it', () => {
    const { user } = buildNotesPrompt({
      ...input,
      taskLinks: [
        { title: 'Strip overlaps navbar', url: '/workspaces/w-b?task=t-9', status: 'todo' },
      ],
    });
    expect(user).toContain('[Strip overlaps navbar](/workspaces/w-b?task=t-9)');
    expect(user).toContain('todo');
    expect(user.toLowerCase()).toContain('markdown link');
  });

  it('says nothing about tasks when the tick captured none', () => {
    const { user } = buildNotesPrompt(input);
    expect(user.toLowerCase()).not.toContain('markdown link');
  });
});

describe('material pulled in, in the prompt', () => {
  it('offers each doc link, its when, and the rule against summarizing it', () => {
    const { user } = buildNotesPrompt({
      ...input,
      docLinks: [
        { title: 'Offline queue notes', url: '/workspaces/w-b/docs/d-q', when: 'last week' },
        { title: 'Team charter', url: '/workspaces/w-b/docs/d-c' },
      ],
    });
    expect(user).toContain('[Offline queue notes](/workspaces/w-b/docs/d-q) — last week');
    // A doc with no meeting behind it gets no when, and no dangling dash.
    expect(user).toContain('[Team charter](/workspaces/w-b/docs/d-c)\n');
    expect(user).not.toContain('[Team charter](/workspaces/w-b/docs/d-c) —');
    // It has not read them, so it may not say what is in them.
    expect(user).toContain('Do not summarize what is inside');
  });

  it('says nothing about material when the tick asked for none', () => {
    const { user } = buildNotesPrompt(input);
    expect(user).not.toContain('asked to have pulled in');
  });
});
