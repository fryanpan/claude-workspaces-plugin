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
import { notesTopicLevel } from './notes-heading-level.ts';
import { MAX_FLAT_RUN_BULLETS } from './notes-quality.ts';
import { endsMeetingNotes } from './notes-section-fit.ts';

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
  /** The heading the room is writing under right now — the last one in the
   *  meeting's section. Only a live topic can be asked where the NEXT note
   *  goes; every topic can be asked to break up the stretch already written.
   *  See {@link closeTopic}. */
  live: boolean;
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
 * Where this MEETING's notes stop — not where its first section does, which
 * ended the scan at the meeting's own second topic. The rule and the story
 * behind it are `endsMeetingNotes` in `notes-section-fit.ts`; this is it read
 * over outline entries.
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
    if (endsMeetingNotes({ level: entry.level, author: entry.author }, level, author)) return i;
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
export type Ask =
  | { kind: 'split'; topic: OvergrownTopic }
  | { kind: 'nest'; target: RegroupTarget };

export interface Scan {
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
export function scanRuns(outline: readonly prose.OutlineEntry[], opts: RegroupOptions): Scan {
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
   * The heading in hand is over: decide what it is asked for.
   *
   * A TOPIC PAST THE PER-HEADING BAR IS ASKED FOR BOTH, and it used to be
   * asked for only the split, on the reasoning that the two remedies
   * contradict each other in one update — nesting being what a note-taker
   * does INSTEAD of moving on. They did contradict each other while a heading
   * could only ever be appended: the ask was "stop adding here, start a new
   * one", and grouping what was already written was the opposite of it. With
   * `insert_before_block` the split is a repair of the stretch already on the
   * page rather than a redirection of the next note, so the two compose —
   * break the stretch where the meeting turned, group what is still flat
   * inside the part that is left. Asked for the split alone, a topic split at
   * its head left the rest of itself a flat wall of up to `topicBar` and no
   * ask ever fired on it: twelve flat bullets at the end of every repaired
   * meeting, measured by `notes-long-topic.test.ts`.
   *
   * EVERY OVERGROWN TOPIC IS NAMED; `live` DECIDES WHICH HALF OF THE REMEDY
   * IT IS ASKED FOR. "Open the next heading" is an instruction about where
   * the NEXT note goes, so a heading the meeting has already moved on from
   * has nothing to carry it out with. Asked for that, the directive repeated
   * on every remaining tick and the note-taker opened a heading a tick: 51
   * headings over 70 ticks, measured by `notes-long-topic.test.ts`. That is
   * why `notes-regroup-ask.ts` withholds that half from a topic that is not
   * live — and it is the whole of what the flag is for.
   *
   * IT USED TO WITHHOLD THE TOPIC ITSELF, and a topic's count does keep
   * rising after the room has left it: `insert_under_heading` lands at the
   * end of whatever heading it names, so a note-taker still writing under an
   * earlier topic grows it with nothing able to ask about it again. Three
   * thirty-minute real-transcript replays on 2026-09-18 ended with 26, 36 and
   * 79 notes under one heading against a bar of twelve, and in the
   * fifteen-minute instrumented run 107 of the 111 ticks that had a topic
   * over the bar raised no ask at all, because the topic over the bar was
   * never the live one. Placing a heading in front of a note already written
   * repairs a topic wherever the room has got to, so the repair half is
   * asked of every topic past the bar.
   */
  const closeTopic = (live: boolean): void => {
    if (headingId !== undefined && topicNotes >= topicBar) {
      const topic = { headingId, heading, notes: topicNotes, live };
      overgrown.push(topic);
      asks.push({ kind: 'split', topic });
    }
    for (let i = topicFrom; i < targets.length; i++) {
      asks.push({ kind: 'nest', target: targets[i]! });
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
    // A NUMBERED ITEM IS AN ORDER THE SPEAKER DICTATED, not a flat bullet:
    // grouping it would undo the order. It ends the run, like a lead does.
    if (entry.ordered && (entry.depth ?? 0) === 0) {
      flush();
      continue;
    }
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
