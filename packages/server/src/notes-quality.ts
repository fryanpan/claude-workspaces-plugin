/**
 * Reading a set of notes the way a checker can: topics, bullets, and the
 * handful of questions about them that have a right answer.
 *
 * WHY THIS IS SOURCE AND NOT A SCRIPT. `bun run notes:eval` asks whether the
 * note-taker behaved — and most of that question needs a model to answer, but
 * some of it does not. "Is any bullet longer than twenty words", "did the same
 * topic get two headings", "is this decision missing the voice that made it",
 * "was a row the notes name left unlinked": those are decidable, and a
 * decidable check belongs somewhere it can be unit-tested rather than inside
 * the harness that consumes it. The eval calls these; so do the behaviour
 * tests, on notes no model wrote.
 *
 * EVERY CHECK RETURNS THE OFFENDERS, NEVER A SCORE. A pass rate is what the
 * eval computes from these; a list of the exact bullets that failed is what
 * somebody tuning the instructions actually needs, and a boolean throws it
 * away.
 */

/**
 * The bar for one bullet, from the row that asked for this behaviour: "no
 * bullet over 20 words". Exported because the number is a product decision
 * that the prompt states and the eval measures, and two copies of it would
 * eventually disagree.
 */
export const MAX_BULLET_WORDS = 20;

/** One topic in a set of notes: its heading, and the bullets under it. */
export interface NotesTopic {
  /** The heading text without its `#` marks. Empty for bullets written
   *  before any heading — a note-taker that wrote no topics at all. */
  heading: string;
  bullets: string[];
}

/**
 * Markdown reduced to the words a reader reads.
 *
 * Link syntax collapses to its LABEL — `[Retry loop wakes the sync](/…)` is
 * the four words of the title, not a URL. Counting the URL would make citing
 * a ticket cost a bullet its length budget, which would teach exactly the
 * wrong lesson.
 *
 * A SPEAKER TAG COLLAPSES TO NOTHING AT ALL. `[@Trent](speaker:A)` is
 * attribution the instructions require and promise is free of the twenty-word
 * budget, so charging for it here would fail a nineteen-word note for obeying
 * them.
 */
export function plainWords(markdown: string): string[] {
  const text = markdown
    // A SPEAKER TAG COSTS NOTHING, because the instructions promise it costs
    // nothing: "the speaker tag does not count towards the twenty". Counting
    // it here would fail a well-behaved nineteen-word note for carrying the
    // attribution the same instructions demand — and the first full eval run
    // did exactly that, reporting a 21-word failure on a bullet whose prose
    // was 19. A rule the writer is told is free must be free to the judge.
    .replace(/\[@[^\]]*\]\(speaker:[^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/^@/, '')
    .replace(/@(?=\w)/g, '');
  return text.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w));
}

/** How long a bullet reads, in words. */
export function bulletWords(bullet: string): number {
  return plainWords(bullet).length;
}

/**
 * A notes section split into its topics.
 *
 * Headings at ANY level become topics: the instructions ask for `###`, the
 * section's own `##` is stripped before this ever sees it, and a model that
 * writes `####` has still opened a topic. Judging the level rather than the
 * act would report a heading as "no topic at all".
 *
 * Nested bullets are flattened to the line they lead with. A sub-bullet is
 * still a bullet a reader reads, and the length bar applies to it.
 */
export function parseNotesTopics(markdown: string): NotesTopic[] {
  const topics: NotesTopic[] = [];
  let current: NotesTopic = { heading: '', bullets: [] };
  let fenced = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      if (current.heading || current.bullets.length > 0) topics.push(current);
      current = { heading: heading[1]!.trim(), bullets: [] };
      continue;
    }
    const bullet = line.match(/^(?:[-*+]|\d+\.)\s+(.*)$/);
    if (bullet && bullet[1]!.trim()) current.bullets.push(bullet[1]!.trim());
  }
  if (current.heading || current.bullets.length > 0) topics.push(current);
  return topics;
}

/** Every bullet in the notes, topics flattened away. */
export function allBullets(markdown: string): string[] {
  return parseNotesTopics(markdown).flatMap((t) => t.bullets);
}

/** The bullets that run past the bar, with their lengths. */
export function overlongBullets(
  markdown: string,
  max: number = MAX_BULLET_WORDS,
): Array<{ bullet: string; words: number }> {
  return allBullets(markdown)
    .map((bullet) => ({ bullet, words: bulletWords(bullet) }))
    .filter((b) => b.words > max);
}

/**
 * Headings that appear more than once — the same topic opened twice.
 *
 * Compared case-insensitively and on words alone, because "Export range" and
 * "Export Range:" are one topic to a reader and two strings to a computer,
 * and the failure this catches is the reader's.
 */
export function duplicateTopics(markdown: string): string[] {
  const seen = new Map<string, { heading: string; count: number }>();
  for (const topic of parseNotesTopics(markdown)) {
    if (!topic.heading) continue;
    const key = topicKey(topic.heading);
    const hit = seen.get(key);
    if (hit) hit.count++;
    else seen.set(key, { heading: topic.heading, count: 1 });
  }
  return [...seen.values()].filter((s) => s.count > 1).map((s) => s.heading);
}

/**
 * One heading reduced to the words a reader reads, for comparing two of them.
 *
 * "Export range" and "Export Range:" are one topic to a reader and two
 * strings to a computer, and every question here that compares headings —
 * were two opened for one topic, is the heading in these notes the one that
 * was in those — is the reader's question.
 *
 * LETTERS AND DIGITS IN ANY SCRIPT, not `a-z0-9`. Stripping to ASCII takes a
 * heading with no Latin characters in it down to the empty string, which
 * makes every such heading equal to every other one — and equal to the
 * heading-less run of bullets a note-taker writes before it opens its first
 * topic. A meeting held in Chinese would have had its topics read as one.
 */
function topicKey(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Headings with no bullets under them.
 *
 * A topic `parseNotesTopics` returns always has a heading OR bullets — it
 * emits nothing for the empty space before the first of either — so an empty
 * bullet list is the whole of the question, and a guard on the heading being
 * non-empty would be a clause no input can reach.
 */
export function emptyHeadings(markdown: string): string[] {
  return parseNotesTopics(markdown)
    .filter((t) => t.bullets.length === 0)
    .map((t) => t.heading);
}

/**
 * Headings this update OPENED and left empty.
 *
 * Frame one of a two-frame action, and the reason this is a question worth
 * asking. The instructions tell the note-taker to "open a new heading as soon
 * as the speech raises a subject the existing headings do not cover … then
 * add its bullets under its own id on the next update" — so a heading with
 * nothing under it yet is the writer obeying, not the writer failing. A
 * heading that was ALREADY there and is still empty is a different thing
 * entirely: nobody ever came back for it. This separates the two, which is
 * what lets a judge wait for frame two without going blind to a heading that
 * never gets one.
 */
export function openedEmptyHeadings(before: string, after: string): string[] {
  const had = new Set(parseNotesTopics(before).map((t) => topicKey(t.heading)));
  return emptyHeadings(after).filter((h) => {
    // A heading whose key comes out empty — a rule, a row of asterisks — is
    // not a subject the room raised, so there are no bullets coming for it
    // and nothing to wait a tick for. Asking `had` about it would compare it
    // against the heading-less run of bullets a note-taker writes before its
    // first topic, which is the same empty key.
    const key = topicKey(h);
    return key.length > 0 && !had.has(key);
  });
}

/** One bullet as it sits on the page, with whatever is indented under it. */
export interface NestedBullet {
  text: string;
  children: NestedBullet[];
}

/**
 * The bullets with their nesting kept, which `parseNotesTopics` throws away.
 *
 * Every other check here is right to read the notes flat: the twenty-word bar
 * applies to a sub-bullet exactly as it applies to a lead bullet, and a reader
 * reads both. Attribution is the one question where the shape matters, because
 * the nested writing rule deliberately splits a point from who made it — the
 * lead bullet carries the point, and the sub-bullets under it carry the
 * option, the number, the objection, and who said it.
 *
 * Indentation is read in columns with tabs expanded to two spaces, because a
 * model that indents with a tab has still written a sub-bullet. A heading
 * starts the tree again: nothing under one heading is a child of a bullet
 * under the previous one.
 */
export function nestedBullets(markdown: string): NestedBullet[] {
  const roots: NestedBullet[] = [];
  const stack: Array<{ indent: number; node: NestedBullet }> = [];
  let fenced = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^#{1,6}\s+/.test(trimmed)) {
      stack.length = 0;
      continue;
    }
    const bullet = trimmed.match(/^(?:[-*+]|\d+\.)\s+(.*)$/);
    const text = bullet?.[1]?.trim();
    if (!text) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const node: NestedBullet = { text, children: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  }
  return roots;
}

/** A speaker tag as the notes carry it: `[@Name](speaker:LABEL)`. */
const SPEAKER_TAG = /\[@[^\]]+\]\(speaker:[^)]+\)/;

/**
 * Bullets that record a decision or an open question without saying whose.
 *
 * The two kinds are spotted by the words a note-taker uses to write them,
 * which is a heuristic and is allowed to be: a bullet this misses is one the
 * model judge still sees, and a bullet this catches wrongly is a bullet whose
 * speaker tag would have done no harm.
 *
 * A LEAD BULLET IS ATTRIBUTED BY ITS SUB-BULLETS. Read flat, this check
 * cannot judge a nested note-taker at all: the two-layer rule puts the point
 * in the lead bullet and the speaker one line below it, so every decision
 * written the way the instructions ask reads as unattributed. Measured on
 * 2026-09-10 — `method:ledger-haiku` on AMI ES2002a scored 8% here while
 * `method:original`, whose flat format opens every bullet with a speaker tag,
 * scored 100%, and the gap was format rather than attribution: twelve of that
 * run's twenty-five lead bullets carried no tag and every one of them had a
 * tagged sub-bullet underneath. A bar that only the flat method can pass
 * cannot be the bar the two ledger methods ship against.
 */
const DECISION_WORDS =
  /\b(decid|agreed|agree to|will |we'll|going to|chose|choosing|settled on|owner|action|next step|takes? this|picking up)/i;
const QUESTION_WORDS =
  /\?|\b(open question|unresolved|unclear whether|asked whether|wants to know)\b/i;

export function decisionsWithoutSpeaker(markdown: string): string[] {
  const out: string[] = [];
  const walk = (bullets: NestedBullet[]): void => {
    for (const bullet of bullets) {
      const claims = DECISION_WORDS.test(bullet.text) || QUESTION_WORDS.test(bullet.text);
      if (claims && !attributedSomewhere(bullet)) out.push(bullet.text);
      walk(bullet.children);
    }
  };
  walk(nestedBullets(markdown));
  return out;
}

/** True when this bullet, or anything indented under it, names a speaker. */
function attributedSomewhere(bullet: NestedBullet): boolean {
  return (
    SPEAKER_TAG.test(bullet.text) || bullet.children.some((child) => attributedSomewhere(child))
  );
}

/** Bullets carrying the marker the instructions ask for on a guess. */
export function unconfirmedBullets(markdown: string): string[] {
  return allBullets(markdown).filter((b) => /\(unconfirmed\)/i.test(b));
}

/**
 * Rows the notes NAME but do not link.
 *
 * The reference search already decided which of the board's titles this
 * meeting's speech contained; this asks the same question of what was
 * WRITTEN, and reports the ones whose title is in the prose with no link
 * around it. A row that reaches the notes as a link and again as bare words
 * later in the same bullet is not reported: the instructions ask for the
 * first mention only.
 */
export function unlinkedReferences(
  markdown: string,
  references: ReadonlyArray<{ title: string; url: string }>,
): string[] {
  const out: string[] = [];
  for (const reference of references) {
    if (markdown.includes(`](${reference.url})`)) continue;
    const spoken = reference.title.toLowerCase();
    if (markdown.toLowerCase().includes(spoken)) out.push(reference.title);
  }
  return out;
}

/**
 * Lines of the notes that are somebody's exact words rather than a note.
 *
 * A cheap, high-precision proxy for "this was not paraphrased": the bullet
 * repeats a run of the transcript verbatim. Eight words is long enough that
 * two people writing about the same thing do not collide by accident and
 * short enough to catch a bullet that copied one clause and trimmed the rest.
 * What it cannot see — a bullet that is transcript-shaped without being
 * word-for-word — is the model judge's half of the same question.
 */
export const VERBATIM_RUN_WORDS = 8;

export function verbatimBullets(
  markdown: string,
  transcript: string,
  run: number = VERBATIM_RUN_WORDS,
): string[] {
  const normalize = (text: string): string[] =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const source = normalize(transcript).join(' ');
  if (!source) return [];
  return allBullets(markdown).filter((bullet) => {
    const words = normalize(plainWords(bullet).join(' '));
    for (let i = 0; i + run <= words.length; i++) {
      if (source.includes(words.slice(i, i + run).join(' '))) return true;
    }
    return false;
  });
}

/**
 * How many bullets one topic may run flat before it reads as a wall.
 *
 * From the row that asked for this behaviour: a topic longer than four
 * bullets is broken up with subheadings or sub-bullets, so it reads as
 * structure rather than as a list. Exported for the same reason
 * `MAX_BULLET_WORDS` is: the prompt states the number and the eval measures
 * it, and two copies of it would eventually disagree.
 */
export const MAX_FLAT_RUN_BULLETS = 4;

/** A stretch of bullets with no structure inside it. */
export interface FlatRun {
  /** The heading it sits under. Empty for bullets written before any
   *  heading — which is the wall this check exists for, in its purest form. */
  heading: string;
  /** The bullets, in order, as the reader meets them. */
  bullets: string[];
}

/**
 * The notes cut into flat runs: consecutive TOP-LEVEL bullets under one
 * heading, with no sub-bullet nesting and no heading between them.
 *
 * WHAT BREAKS A RUN IS THE POINT, so each break is deliberate:
 *
 * - A HEADING of any level. A `####` under a `###` is a subheading to a
 *   reader and a break to this, which is the whole regrouping affordance.
 * - A SUB-BULLET, and it takes its parent out of the run with it. A bullet
 *   that has points nested under it is not a flat bullet — it is the lead of
 *   a group — so counting it inside the run it introduces would report the
 *   regrouped shape as the unregrouped one.
 *
 * Blank lines and prose do NOT break a run. A loose list is still one list to
 * a reader, and the notes are bullets by instruction, so a paragraph between
 * two of them is a defect on its own rather than the structure this looks
 * for.
 *
 * `parseNotesTopics` cannot answer this: it trims every line before reading
 * it and flattens each sub-bullet into the list, which is right for the
 * length bar and blind to exactly the nesting this measures.
 */
export function flatBulletRuns(markdown: string): FlatRun[] {
  const runs: FlatRun[] = [];
  let heading = '';
  let run: string[] = [];
  let fenced = false;
  const flush = (): void => {
    if (run.length > 0) runs.push({ heading, bullets: run });
    run = [];
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const head = line.match(/^#{1,6}\s+(.*)$/);
    if (head) {
      flush();
      heading = head[1]!.trim();
      continue;
    }
    const bullet = line.match(/^(?:[-*+]|\d+\.)\s+(.*)$/);
    if (!bullet || !bullet[1]!.trim()) continue;
    if (/^\s/.test(raw)) {
      // A sub-bullet. The bullet above it is its lead, not a flat bullet, so
      // it leaves the run before the run is closed.
      run.pop();
      flush();
      continue;
    }
    run.push(bullet[1]!.trim());
  }
  flush();
  return runs;
}

/** The runs that pass the bar — the topics reading as a wall of bullets. */
export function longFlatRuns(markdown: string, max: number = MAX_FLAT_RUN_BULLETS): FlatRun[] {
  return flatBulletRuns(markdown).filter((r) => r.bullets.length > max);
}
