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
 * AND A RUN NOBODY HAS NAMED IS ASKED FOR A HEADING, NOT A GROUP, WHICH COST
 * TWO MEASURED BARS TO GET RIGHT. A run above every heading is the same wall
 * to `flatBulletRuns`, so the first version asked it for the same nesting; on
 * the eval's ES2002a ledger-haiku slice that took "notes are organised under
 * topics" from 83% to 0%, the note-taker nesting its four homeless bullets in
 * place and never opening the topic heading. Staying silent there was no
 * better: EVERY flat-run failure on the 43-tick ES2002b slice reads
 * `under "(no heading)"`, because a ledger note-taker writes for several
 * ticks before it names a topic. So each wall gets the remedy that fits it,
 * and no instruction here can be carried out by doing another.
 *
 * ═══ THE THIRD REMEDY, AND THE TWO BUGS THAT HID IT (2026-09-16) ═══
 *
 * On 16 September one heading in a real meeting's notes carried twenty-nine
 * minutes of talk — sixty-five bullets in its longest unbroken run — with the
 * bar at four and this module counting every tick. Three things were wrong:
 *
 * 1. THE MEETING'S OWN HEADING WAS SLICED OUT OF ITS OWN SCOPE. `sectionOf`
 *    returned the blocks AFTER the section heading, so the scan began with no
 *    heading in hand, reported the meeting's first topic as HOMELESS, and
 *    told a note-taker looking straight at that heading to open one. The nest
 *    ask could not fire for a live meeting's own section at all. Every unit
 *    test of the scoped path happened to assert an empty result, so an
 *    always-wrong answer read as the right one; `notes-long-topic.test.ts`
 *    drives a whole meeting instead, which is what caught it.
 * 2. THE SCOPE STOPPED AT THE MEETING'S SECOND TOPIC. A section ends at the
 *    next heading of its own level (`notesSectionEnd`), and the prompt asks
 *    for every new topic at exactly that level — so the moment the room moved
 *    on, everything said afterwards was outside the scan, which is almost all
 *    of a meeting. `meetingSectionEnd` below walks past a heading THE
 *    NOTE-TAKER WROTE and stops at one it did not, which keeps the protection
 *    the slice existed for: a long list in somebody else's section is still
 *    not this meeting's wall.
 * 3. THERE WAS ONE REMEDY UNDER A HEADING. The owner's rule names three —
 *    subtopic bullets, headings, subheadings — and only nesting was ever
 *    asked for. Nesting cannot repair a heading that has swallowed half an
 *    hour: the reader still meets one heading with the whole stretch under
 *    it, now in groups. `MAX_TOPIC_NOTES` is the second bar, and a topic past
 *    it is asked to open the next heading instead of nesting again.
 *
 * WHAT THE ASK CANNOT DO, AND WHY IT IS STILL THE RIGHT ASK. A heading is
 * appended; there is no edit that moves an existing bullet under one. So the
 * bullets already written stay above the heading they earned, and only what
 * comes after it goes under it. That is enough because of what the bars
 * count: once the heading exists the run and the topic above it stop GROWING.
 * Measured end to end over a seventy-tick meeting whose room never leaves its
 * subject, with a note-taker that does exactly what it is asked: 65 flat
 * bullets under one heading before, 3 after, the largest topic 65 before and
 * 12 after, seven headings, none of them opened twice, and every one of the
 * seventy ticks still leaving its note.
 */

import type { prose } from '@claude-workspaces/core';
import {
  headingLevelLine,
  notesSubTopicHashes,
  notesTopicHashes,
  notesTopicLevel,
} from './notes-heading-level.ts';
import { MAX_FLAT_RUN_BULLETS } from './notes-quality.ts';

/**
 * How many notes one heading may stand over before it has stopped being a
 * topic.
 *
 * TWELVE: three groups of `MAX_FLAT_RUN_BULLETS`, the most a reader holds in
 * their head as one subject. The flat-run bar asks what a STRETCH of notes
 * looks like and is answered by nesting; this one asks what a HEADING is
 * worth and cannot be — a topic nested into four tidy groups is still a
 * heading with half an hour under it, and the reader looking for what was
 * said about the crane still has one entry in the outline to go on. Like the
 * flat-run bar it fires AT the number rather than past it, because the
 * directive is built from the doc BEFORE this tick's edits.
 *
 * It counts the notes directly under a heading, so opening a sub-topic for
 * the part the room has reached RESETS it. That is the whole incentive: the
 * cheapest way to stay under this bar is to say what the room is now talking
 * about.
 */
export const MAX_TOPIC_NOTES = MAX_FLAT_RUN_BULLETS * 3;

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

/** A heading that has stopped being a subject: more notes under it than
 *  `MAX_TOPIC_NOTES`, however they are arranged. */
export interface OvergrownTopic {
  headingId: string;
  heading: string;
  /** Every note directly under it, nested ones and paragraph notes included. */
  notes: number;
}

/** A run of top-level bullets sitting above every heading — a wall the room
 *  cannot navigate because nothing says what it is about. */
export interface HomelessRun {
  /** How long the run is by the BAR's reckoning. */
  runLength: number;
  /** The bullets in it, in document order, the note-taker's own first. */
  bullets: Array<{ id: string; text: string }>;
}

export interface RegroupOptions {
  /** The agent whose bullets may be moved — the note-taker's own id. */
  author: string;
  /** This meeting's section heading. Given, the scan starts THERE and runs to
   *  the end of the meeting's own topics; a doc whose other sections happen
   *  to hold a long list is not this meeting's wall, and telling the
   *  note-taker to regroup somebody else's document would be worse than
   *  saying nothing. */
  notesHeadingId?: string | undefined;
  /** The flat-run bar, for a test that wants a smaller doc to cross it. */
  bar?: number;
  /** The per-heading bar, for the same reason. */
  topicBar?: number;
}

/**
 * Where this MEETING's notes stop — not where its first section does.
 *
 * A section ends at the next heading of its own level, and the prompt asks
 * for every new topic at exactly that level, so the section rule ended the
 * scan at the meeting's own second topic. What actually ends the meeting's
 * notes is a heading it did not write: the document's own material, which
 * this must never tell the note-taker to reorganise.
 *
 * A heading a PERSON has since edited reads as theirs (the doc clears
 * authorship on a person's edit), so renaming a topic mid-meeting stops the
 * scan there. That is the conservative direction — it goes quiet rather than
 * reaching into a block somebody has taken over — and it is the same reading
 * of "yours" every other part of this pipeline uses.
 */
function meetingSectionEnd(
  outline: readonly prose.OutlineEntry[],
  at: number,
  author: string,
): number {
  const level = outline[at]?.level ?? notesTopicLevel(outline);
  for (let i = at + 1; i < outline.length; i++) {
    const entry = outline[i];
    if (entry?.kind !== 'heading') continue;
    if ((entry.level ?? 0) > level) continue;
    if (entry.author === author) continue;
    return i;
  }
  return outline.length;
}

/** The slice of the outline that is this meeting's notes, or the whole
 *  outline when the meeting has not opened a heading yet. IT INCLUDES THE
 *  SECTION HEADING ITSELF: it used to start one block later, which met the
 *  meeting's first topic with no heading in hand — see the header. */
function sectionOf(
  outline: readonly prose.OutlineEntry[],
  opts: RegroupOptions,
): readonly prose.OutlineEntry[] {
  const id = opts.notesHeadingId;
  if (id === undefined) return outline;
  const at = outline.findIndex((e) => e.id === id);
  if (at < 0) return outline;
  return outline.slice(at, meetingSectionEnd(outline, at, opts.author));
}

/** One thing the directive asks for, about one heading. */
type Ask = { kind: 'split'; topic: OvergrownTopic } | { kind: 'nest'; target: RegroupTarget };

interface Scan {
  targets: RegroupTarget[];
  overgrown: OvergrownTopic[];
  /** One per heading that needs something, in document order. */
  asks: Ask[];
  homeless: HomelessRun | null;
}

/**
 * One pass over the outline, splitting what has reached a bar into the three
 * kinds that need different remedies.
 *
 * The run boundaries mirror `flatBulletRuns` in `notes-quality.ts`, which is
 * what the eval scores, so this cannot report a topic the bar would not: a
 * heading of any level breaks a run, a sub-bullet breaks it AND takes the
 * bullet above it out (that bullet is a group's lead, not a flat bullet), and
 * a paragraph note breaks nothing and counts as a note. Two readings of "what is a
 * flat run" that disagree would make the directive fire on topics the eval
 * calls fine and stay silent on the ones it does not.
 *
 * The per-heading count is the same set of blocks read the other way: every
 * note under the heading whatever its depth, which is what `parseNotesTopics`
 * counts and therefore what a reader meets.
 */
function scanRuns(outline: readonly prose.OutlineEntry[], opts: RegroupOptions): Scan {
  const bar = opts.bar ?? MAX_FLAT_RUN_BULLETS;
  const topicBar = opts.topicBar ?? MAX_TOPIC_NOTES;
  const targets: RegroupTarget[] = [];
  const overgrown: OvergrownTopic[] = [];
  const asks: Ask[] = [];
  let homeless: HomelessRun | null = null;
  const scoped = sectionOf(outline, opts);
  let heading = '';
  let headingId: string | undefined;
  let run: prose.OutlineEntry[] = [];
  /** Every note under the heading in hand, nested ones included. */
  let topicNotes = 0;
  /** Where in `targets` this heading's own entries begin. */
  let topicFrom = 0;
  const flush = (): void => {
    const mine = run.filter((e) => e.author === opts.author);
    if (run.length >= bar) {
      // Only a list item can be nested under a lead, so a paragraph note counts
      // towards the bar and is never offered as a block to move.
      const nestable = mine.filter((e) => e.kind === 'listItem');
      if (headingId === undefined) {
        // At most one run can be homeless — a heading, once seen, stands over
        // everything after it — and the earliest is the one to name.
        homeless ??= {
          runLength: run.length,
          bullets: mine.map((e) => ({ id: e.id, text: e.text })),
        };
        // Two is the fewest bullets that can become a group. One movable bullet
        // in a run of five is a topic the note-taker cannot fix, and telling it
        // to anyway spends prompt on an instruction with no legal answer.
      } else if (nestable.length >= 2) {
        targets.push({
          headingId,
          heading,
          runLength: run.length,
          movable: nestable.map((e) => ({ id: e.id, text: e.text })),
        });
      }
    }
    run = [];
  };
  /**
   * The heading in hand is over: decide its ONE ask.
   *
   * A topic past the per-heading bar is asked to open the next heading and
   * NOT also to nest, because the two remedies contradict each other in the
   * same update — nesting is what it does instead of moving on, and a model
   * handed both does whichever it read last.
   *
   * AND ONLY THE HEADING THE ROOM IS UNDER RIGHT NOW CAN BE ASKED TO SPLIT,
   * which is what `live` says. "Open the next heading" is an instruction
   * about where the NEXT note goes, so a heading the meeting has already
   * moved on from has nothing to carry it out with — its count cannot fall,
   * because nothing is being added to it any more. Asked anyway, the
   * directive repeated on every remaining tick of the meeting and the
   * note-taker opened a heading a tick: 51 headings over 70 ticks, measured
   * by `notes-long-topic.test.ts` before this clause existed. Nesting is a
   * repair of what is already written, so it carries no such restriction.
   */
  const closeTopic = (live: boolean): void => {
    if (live && headingId !== undefined && topicNotes >= topicBar) {
      const topic = { headingId, heading, notes: topicNotes };
      overgrown.push(topic);
      asks.push({ kind: 'split', topic });
    } else {
      for (let i = topicFrom; i < targets.length; i++) {
        asks.push({ kind: 'nest', target: targets[i]! });
      }
    }
    topicFrom = targets.length;
    topicNotes = 0;
  };
  for (const entry of scoped) {
    if (entry.kind === 'heading') {
      flush();
      closeTopic(false);
      heading = entry.text;
      headingId = entry.id;
      continue;
    }
    if (entry.kind !== 'listItem') {
      // A NOTE WRITTEN AS A PARAGRAPH IS STILL A NOTE IN THE RUN. Skipped, twelve
      // of them under no heading read as a run of three and the heading was
      // never asked for (a huddle on 2026-09-14).
      if (entry.nodeName === 'paragraph' && entry.text.trim().length > 0) {
        run.push(entry);
        topicNotes++;
      }
      continue;
    }
    topicNotes++;
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
  closeTopic(true);
  return { targets, overgrown, asks, homeless };
}

/** The topics under a heading that have filled up. */
export function regroupTargets(
  outline: readonly prose.OutlineEntry[],
  opts: RegroupOptions,
): RegroupTarget[] {
  return scanRuns(outline, opts).targets;
}

/** The headings that have stopped being subjects — more than
 *  `MAX_TOPIC_NOTES` under one of them. */
export function overgrownTopics(
  outline: readonly prose.OutlineEntry[],
  opts: RegroupOptions,
): OvergrownTopic[] {
  return scanRuns(outline, opts).overgrown;
}

/** The run above every heading that has filled up, if there is one. */
export function homelessRun(
  outline: readonly prose.OutlineEntry[],
  opts: RegroupOptions,
): HomelessRun | null {
  return scanRuns(outline, opts).homeless;
}

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
      'THIS SPEECH HAS RUN PAST ONE HEADING — OPEN THE NEXT ONE IN THIS UPDATE.',
      `A heading holding ${topicBar} notes has stopped naming a subject and has`,
      'started standing over a stretch of the meeting. Nesting cannot repair',
      'that: the reader still meets one heading with the whole stretch under',
      'it, only in groups. So do NOT nest these and do NOT add another bullet',
      'to them.',
      '',
      `${headingLevelLine(outline)} Open the one this speech belongs under — a`,
      `\`${notesSubTopicHashes(outline)} \` sub-topic where the room is still on the subject and has`,
      `reached a new part of it, a \`${notesTopicHashes(outline)} \` topic where it has moved on.`,
      '',
      "ONE insert_at_end CARRIES THE HEADING AND THIS SPEECH'S POINTS TOGETHER,",
      'so nothing said now waits a tick for somewhere to go:',
      `  {"op":"insert_at_end","markdown":"${notesSubTopicHashes(outline)} <what this part is about>\\n\\n- the point"}`,
      '',
      'Nothing moves: the notes already written stay exactly where they are.',
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
