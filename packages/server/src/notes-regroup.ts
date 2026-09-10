/**
 * Telling the note-taker WHICH topic has become a wall, in the tick that is
 * about to make it one.
 *
 * The instructions have asked for a topic past the flat-run bar to be
 * gathered into groups since the day the bar existed, and the eval measured
 * the rule holding on between 2% and 17% of ticks — the worst bar in the
 * corpus, failing about equally on all three shipped methods. A rule all
 * three ignore equally is not a method problem and it is not a wording
 * problem; it is a rule nobody can act on. Two things stopped it being
 * actionable, and both were the prompt's fault rather than the model's:
 *
 * - THE OUTLINE COULD NOT SHOW A GROUP. Every bullet printed on one line in
 *   one shape, so a topic already regrouped read exactly like a flat one.
 *   A note-taker cannot avoid a wall it cannot see, and cannot tell that it
 *   has already built the fix. `OutlineEntry.depth` is the other half of this
 *   change and is what makes a sub-bullet legible.
 * - NOTHING COUNTED. "More than four bullets under one heading" asks the
 *   model to hold a running count of a doc it is shown 80 blocks of, every
 *   tick, while writing notes about somebody talking. The count is arithmetic
 *   the server can do exactly, so it does it here and names the ids.
 *
 * WHY IT FIRES AT THE BAR AND NOT PAST IT. The outline a tick is handed is
 * the doc BEFORE that tick's edits, so a directive that waited for a
 * fifth bullet could only ever arrive after the wall existed. Firing at four
 * — the largest run still inside the bar — is what puts the regroup in the
 * same tick that would otherwise cross it: the topic is full, so this tick's
 * point goes under a group rather than on the end.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is fire on a short topic. A meeting with
 * one three-bullet subject reads best as three bullets, and grouping that has
 * not been earned is its own defect; `regroupTargets` returns nothing until a
 * run reaches the bar with at least two of the note-taker's own bullets in
 * it, which is the fewest that can become a group.
 *
 * AND IT NEVER FIRES ON A RUN WITH NO HEADING, WHICH COST A MEASURED BAR TO
 * LEARN. A headingless run is the same wall to `flatBulletRuns`, so the first
 * version reported it and asked for the same nesting. On the eval's ES2002a
 * ledger-haiku slice that took "notes are organised under topics" from 83% to
 * 0%: told at tick 1 that its four homeless bullets were a full topic to be
 * grouped in place, the note-taker nested them and never opened the `###`
 * heading the prompt asks for, and the meeting ran to its end with no topic in
 * it. The flat-run bar went to 92% and the notes got worse.
 *
 * The cure for a homeless run is a HEADING, not a group, and the prompt
 * already asks for one. So this stays silent there and leaves that run to the
 * rule that is right about it — the two mechanisms cannot fight over the same
 * bullets, and the flat-run bar reads a headingless wall until a heading
 * arrives, which is the honest reading of a topic nobody has named.
 */

import type { prose } from '@claude-workspaces/core';
import { MAX_FLAT_RUN_BULLETS } from './notes-quality.ts';
import { notesSectionEnd } from './notes-section-fit.ts';

/** One topic that has filled up, and the bullets it filled up with. */
export interface RegroupTarget {
  /** The heading the run sits under. Always present: a run above every
   *  heading is not reported at all — see the header. */
  headingId: string;
  /** Its words, for the directive to name. */
  heading: string;
  /** How long the run is by the BAR's reckoning — every top-level bullet in
   *  it, a person's included. This is the number the eval counts. */
  runLength: number;
  /** The bullets of that run the note-taker may actually move: its own, still
   *  untouched. In document order. */
  movable: Array<{ id: string; text: string }>;
}

export interface RegroupOptions {
  /** The agent whose bullets may be moved — the note-taker's own id. */
  author: string;
  /** This meeting's section heading. Given, only that section is read; a doc
   *  whose other sections happen to hold a long list is not this meeting's
   *  wall, and telling the note-taker to regroup somebody else's document
   *  would be worse than saying nothing. */
  notesHeadingId?: string | undefined;
  /** The flat-run bar, for a test that wants a smaller doc to cross it. */
  bar?: number;
}

/** The slice of the outline that is this meeting's section, or the whole
 *  outline when the meeting has not opened one yet. */
function sectionOf(
  outline: readonly prose.OutlineEntry[],
  notesHeadingId: string | undefined,
): readonly prose.OutlineEntry[] {
  if (notesHeadingId === undefined) return outline;
  const at = outline.findIndex((e) => e.id === notesHeadingId);
  if (at < 0) return outline;
  return outline.slice(at + 1, notesSectionEnd(outline, at));
}

/**
 * The runs of top-level bullets that have reached the bar.
 *
 * The run boundaries mirror `flatBulletRuns` in `notes-quality.ts`, which is
 * what the eval scores, so this cannot report a topic the bar would not: a
 * heading of any level breaks a run, a sub-bullet breaks it AND takes the
 * bullet above it out (that bullet is a group's lead, not a flat bullet), and
 * a paragraph between two bullets breaks nothing. Two readings of "what is a
 * flat run" that disagree would make the directive fire on topics the eval
 * calls fine and stay silent on the ones it does not.
 */
export function regroupTargets(
  outline: readonly prose.OutlineEntry[],
  opts: RegroupOptions,
): RegroupTarget[] {
  const bar = opts.bar ?? MAX_FLAT_RUN_BULLETS;
  const targets: RegroupTarget[] = [];
  const scoped = sectionOf(outline, opts.notesHeadingId);
  let heading = '';
  let headingId: string | undefined;
  let run: prose.OutlineEntry[] = [];
  const flush = (): void => {
    const movable = run
      .filter((e) => e.author === opts.author)
      .map((e) => ({ id: e.id, text: e.text }));
    // Two is the fewest bullets that can become a group. One movable bullet
    // in a run of five is a topic the note-taker cannot fix, and telling it
    // to anyway spends prompt on an instruction with no legal answer.
    if (headingId !== undefined && run.length >= bar && movable.length >= 2) {
      targets.push({ headingId, heading, runLength: run.length, movable });
    }
    run = [];
  };
  for (const entry of scoped) {
    if (entry.kind === 'heading') {
      flush();
      heading = entry.text;
      headingId = entry.id;
      continue;
    }
    if (entry.kind !== 'listItem') continue;
    if ((entry.depth ?? 0) > 0) {
      // A sub-bullet. The bullet above it leads a group rather than sitting
      // flat, so it leaves the run before the run is closed.
      run.pop();
      flush();
      continue;
    }
    run.push(entry);
  }
  flush();
  return targets;
}

/** How many bullets one group should gather, when the model is left to pick.
 *  Three is what takes a run of six to two groups and a run of four to two
 *  bullets — small enough that a group is still one idea. */
const SUGGESTED_GROUP_SIZE = 3;

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
 */
export function regroupDirective(
  outline: readonly prose.OutlineEntry[],
  opts: RegroupOptions,
): string | null {
  const targets = regroupTargets(outline, opts);
  if (targets.length === 0) return null;
  const bar = opts.bar ?? MAX_FLAT_RUN_BULLETS;
  const lines: string[] = [
    `THESE TOPICS ARE FULL — GROUP THEM IN THIS UPDATE. A topic may run ${bar}`,
    'bullets flat; each one below has reached that. Do NOT add another bullet',
    'to one of them: gather the bullets it already has into groups instead,',
    'with nest_blocks, and put whatever this speech adds to that topic under',
    'the group it belongs to on the next update.',
    '',
    'nest_blocks MOVES bullets under a lead bullet. It rewrites nothing and',
    'deletes nothing, so it never costs a point and never breaks a comment',
    'somebody has left on one. Pick the bullet that best introduces a group as',
    `the lead and name the other ${SUGGESTED_GROUP_SIZE - 1} or so under it; repeat for the rest.`,
  ];
  for (const target of targets) {
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
  return lines.join('\n');
}
