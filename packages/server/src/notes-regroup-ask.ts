/**
 * The words the note-taker is asked the regroup in — the rendering half of
 * `notes-regroup.ts`, which counts.
 *
 * SPLIT FROM IT BECAUSE THE TWO HALVES ANSWER DIFFERENT QUESTIONS. What the
 * scan decides — which runs are flat, which topic has swallowed a stretch of
 * the meeting, whether anything is homeless — is read by tests, by the eval
 * and by the huddle replay, none of which want a paragraph of prompt. What
 * this file decides is how to SAY it to a model, and it is paid for at full
 * rate on every tick (see {@link REGROUP_TOPICS_NAMED}), so its length is a
 * cost rather than an inconvenience. One import crosses the seam, one way.
 */

import type { prose } from '@claude-workspaces/core';
import { headingLevelLine, notesSubTopicHashes, notesTopicHashes } from './notes-heading-level.ts';
import { MAX_FLAT_RUN_BULLETS } from './notes-quality.ts';
import { MAX_TOPIC_NOTES, type RegroupOptions, scanRuns } from './notes-regroup.ts';

/** How many bullets one group should gather, when the model is left to pick.
 *  Three is what takes a run of six to two groups and a run of four to two
 *  bullets — small enough that a group is still one idea. */
const SUGGESTED_GROUP_SIZE = 3;

/**
 * How many full topics one directive names.
 *
 * THE DIRECTIVE IS THE ONE PART OF THE PROMPT NOTHING CAN CACHE — it is
 * recomputed every tick and turns on and off, so it sits after the last cache
 * breakpoint and is paid at the full rate on every tick of the meeting. It
 * used to name every full topic in the section, which cost nothing while the
 * outline was a window over the last eighty blocks and became the largest
 * thing in the prompt the moment the whole doc was sent: measured over 348
 * ticks of a fixture-driven meeting on 2026-09-15, the directive reached
 * 37,000 characters by the last tick and averaged 18,800 — about nineteen
 * twentieths of everything the tick paid full price for — and it took the
 * whole-doc prompt from $1.90 to $3.09 over those 348 ticks, where capping it
 * takes the same prompt to $1.06.
 *
 * TWO, AND THE LAST TWO. The ask is "do this IN THIS UPDATE", and an update
 * writes a handful of edits: a list of twelve topics is not a bigger ask, it
 * is an ask nobody can carry out, and the topics at the top of it are the
 * ones the room stopped talking about half an hour ago. Document order is
 * chronological, so the last two are the topic this speech is about and the
 * one before it — the two a tick can actually add a bullet to. A topic left
 * unnamed is not forgotten: it is still full on the next tick, and it is
 * named as soon as it is one of the two nearest the live end.
 */
const REGROUP_TOPICS_NAMED = 2;

/**
 * The directive as it reaches the prompt, or `null` when nothing has filled
 * up — which is the overwhelmingly common tick, and the one this must cost
 * nothing.
 *
 * It names ids rather than describing a shape, because the edit it is asking
 * for is addressed by id and a model that has to re-derive which bullets it
 * meant will pick the wrong ones. The bullets it lists are the ones the
 * note-taker may move; a person's bullet in the same run is counted in the
 * length and left out of the list, so the group forms around it.
 *
 * A homeless run is named FIRST when there is one, because its remedy has to
 * happen before the others can: bullets get a heading, and only then can that
 * heading's notes be grouped or moved on from.
 */
export function regroupDirective(
  outline: readonly prose.OutlineEntry[],
  opts: RegroupOptions,
): string | null {
  const { asks: everyAsk, homeless } = scanRuns(outline, opts);
  // The last few only — see `REGROUP_TOPICS_NAMED`.
  const asks = everyAsk.slice(-REGROUP_TOPICS_NAMED);
  if (asks.length === 0 && homeless === null) return null;
  const bar = opts.bar ?? MAX_FLAT_RUN_BULLETS;
  const topicBar = opts.topicBar ?? MAX_TOPIC_NOTES;
  const lines: string[] = [];
  if (homeless !== null) {
    lines.push(
      `THE NOTES HAVE RUN TO ${homeless.runLength} BULLETS UNDER NO HEADING — OPEN ONE IN`,
      `THIS UPDATE. A list ${bar} bullets long that nothing names is the wall these`,
      'notes exist instead of, and what it is missing is the topic, not a',
      'group: nesting bullets nobody has named leaves them just as homeless.',
      `Insert the \`${notesTopicHashes(outline)} \` heading these belong under, then put this`,
      "speech's points under its id on the next update. Where they are two subjects,",
      'open the heading for the one this speech is about.',
      '',
      'The bullets waiting for a heading:',
    );
    for (const bullet of homeless.bullets) lines.push(`    ${bullet.id} | ${bullet.text}`);
  }
  const splits = asks.flatMap((a) => (a.kind === 'split' ? [a.topic] : []));
  const nests = asks.flatMap((a) => (a.kind === 'nest' ? [a.target] : []));
  if (splits.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      'THIS SPEECH HAS RUN PAST ONE HEADING — BREAK IT UP IN THIS UPDATE.',
      `A heading holding ${topicBar} notes has stopped naming a subject and has`,
      'started standing over a stretch of the meeting. Nesting alone cannot',
      'repair that: the reader still meets one heading with the whole stretch',
      'under it, only in groups. Break the stretch first; group inside the',
      'part that is left, if the update below also asks you to.',
      '',
      `${headingLevelLine(outline)} A \`${notesSubTopicHashes(outline)} \` names a new part of the same`,
      `subject; a \`${notesTopicHashes(outline)} \` names a subject the room has moved on to.`,
      '',
      'TWO PLACES A HEADING CAN GO, AND THE STRETCH ALREADY WRITTEN NEEDS THE',
      'FIRST ONE. Read the notes under it: where the meeting turned to a new',
      'part, put a heading IN FRONT OF the note that turn begins at, and every',
      'note from there down comes under it.',
      `  {"op":"insert_before_block","blockId":"<the note the new part starts at>","markdown":"${notesSubTopicHashes(outline)} <what that part is about>"}`,
      'Name a note under this heading, at the top level of its list. Nothing is',
      'retyped and nothing is lost: every note keeps its words and its id, and',
      'only the heading above them changes. Do this even when this speech adds',
      'nothing — the stretch already written is what the reader is stuck in.',
      '',
      "AND THIS SPEECH'S OWN POINTS GO UNDER A HEADING OF THEIR OWN, in the same",
      'update, so nothing said now waits a tick for somewhere to go:',
      `  {"op":"insert_at_end","markdown":"${notesSubTopicHashes(outline)} <what this part is about>\\n\\n- the point"}`,
    );
    for (const topic of splits) {
      lines.push(`- "${topic.heading}" (${topic.headingId}) — ${topic.notes} notes under it.`);
    }
  }
  if (nests.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `THESE TOPICS ARE FULL — GROUP THEM IN THIS UPDATE. A topic may run ${bar}`,
      'bullets flat; each one below has reached that. Gather the bullets it',
      'already has into groups, with nest_blocks, in the same update that',
      "writes this speech's own points. Keep every idea: nesting is a second",
      'edit in the batch, never a reason to leave a point out.',
      '',
      'nest_blocks MOVES bullets under a lead bullet. It rewrites nothing and',
      'deletes nothing, so it never costs a point and never breaks a comment',
      'somebody has left on one. Pick the bullet that best introduces a group as',
      `the lead and name the other ${SUGGESTED_GROUP_SIZE - 1} or so under it; repeat for the rest.`,
    );
    for (const target of nests) {
      lines.push('');
      lines.push(
        `- "${target.heading}" (${target.headingId}) — ${target.runLength} flat ` +
          'bullets. Yours, in order:',
      );
      for (const bullet of target.movable) lines.push(`    ${bullet.id} | ${bullet.text}`);
      const lead = target.movable[0];
      const rest = target.movable.slice(1, SUGGESTED_GROUP_SIZE).map((b) => b.id);
      if (lead && rest.length > 0) {
        lines.push(
          `  e.g. {"op":"nest_blocks","leadBlockId":"${lead.id}","blockIds":${JSON.stringify(rest)}}`,
        );
      }
    }
  }
  return lines.join('\n');
}
