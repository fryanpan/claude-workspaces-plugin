/**
 * The words of an owner check's card — the fixed template the server writes
 * over a done-when line marked `owner` and its proof.
 *
 * Out of `done-when-owner.ts` so the template and the two facts the gate and
 * the sync need about it sit in one place: which sentences are the BOARD'S
 * rather than the filer's (`ownerCheckBoilerplate`, so a hold never names
 * one), and which line state a card was last written from
 * (`ownerTemplateKey`, so a re-report of an unchanged line does not write the
 * template back over a revision the filer made to answer a hold).
 */
import { REVIEW_LIMITS } from '@claude-workspaces/core';
import type { DoneWhenLine, DoneWhenProof } from '@claude-workspaces/core/done-when';
import { refusalProof } from '@claude-workspaces/core/done-when-refusal';
import type { Task } from '@claude-workspaces/core/task-wire';

/** The option that meets the line. Every other answer leaves it not met. */
export const OWNER_CHECK_MET = 'looks-right';
export const OWNER_CHECK_NOT_MET = 'not-met';

function isHttp(url: string | undefined): url is string {
  return url !== undefined && /^https?:\/\//.test(url);
}

/** The sentences of the template the server writes whatever the line says.
 *  Named so `ownerCheckBoilerplate` lists the same strings the card uses. */
const OPENING_REFUSED =
  'Nothing was run: this machine refused the agent permission to check it, so the check is yours.';
const OPENING_NOTHING_LINKED = 'Nothing is linked to open, so find it first.';
const MET_DETAIL = 'Marks this line met. The task closes once every line is.';
const NOT_MET_DETAIL = 'Sends it back to the builder with what you write.';

/** What each answer does — the one generated sentence that names the task. */
function answersSentence(task: Task, line: DoneWhenLine): string {
  return `Looks right marks this line of \u201c${task.title}\u201d met, and the task closes once every line is; Not met sends it back to ${line.by || 'the builder'} with your words.`;
}

/** The headline budget every hand-written item is advised by. A generated
 *  item HOLDS to it: the card clamps at that width on a phone, and the first
 *  generated items shipped a whole acceptance criterion as their title —
 *  209 characters on the reader's queue (measured 2026-09-15). */
const HEADLINE_MAX = REVIEW_LIMITS.headline;

/** How long a link's words may run before the label is derived from the URL
 *  instead. A label is a thing to tap, not a paragraph to read. */
const LABEL_MAX = 60;

/** How much of a proof's own words the card carries as context. Past this it
 *  is a document, and the link is right there. */
const NOTE_MAX = 400;

/** `text` on one line, cut at the last word boundary that fits, with an
 *  ellipsis. Word-boundary rather than mid-word: a clipped headline is the
 *  only thing a reader sees in a list, and a cut word reads as a bug. */
function clipWords(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const kept = space > max / 2 ? cut.slice(0, space) : cut;
  return `${kept.replace(/[\s,;:.]+$/, '')}\u2026`;
}

/** A full stop that ends a word nobody means as a sentence: an abbreviation
 *  or an initial. Without this, "Works on iOS, e.g. Mobile Safari" headlines
 *  as "Check: Works on iOS, e.g" (codex review). */
const ABBREVIATION = /(?:\be\.g|\bi\.e|\betc|\bvs|\bcf|\bal|\bapprox|\bfig|\bno|\s[A-Za-z])\.$/i;

/** Shorter than this and a "sentence" is a fragment, so the next one is
 *  taken with it rather than a headline reading "Check: Yes". */
const MIN_SENTENCE = 24;

/** The first sentence of a line — what the headline says when the line itself
 *  is a paragraph. Sentences are taken together until one ends somewhere a
 *  reader would stop. */
function firstSentence(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  let acc = '';
  for (const part of one.split(/(?<=[.!?])\s+(?=[A-Z(\[])/)) {
    acc = acc === '' ? part : `${acc} ${part}`;
    if (acc.length >= MIN_SENTENCE && !ABBREVIATION.test(acc)) return acc;
  }
  return one;
}

/** `text` ending in sentence punctuation, so a quoted note does not read as
 *  cut off and the template never doubles a full stop. */
function sentence(text: string): string {
  return /[.!?\u2026]$/.test(text) ? text : `${text}.`;
}

/** Trailing sentence punctuation removed, so the template adds its own. */
function unpunctuated(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?\u2026]+$/, '');
}

/**
 * What the reader decides, in one line they can act on from a list on a
 * phone: the line's first sentence, clipped to the same budget a hand-written
 * headline is advised by. The whole line is still in the detail, so nothing a
 * clip drops is lost.
 */
export function ownerCheckHeadline(line: DoneWhenLine): string {
  const prefix = 'Check: ';
  return `${prefix}${clipWords(unpunctuated(firstSentence(line.text)), HEADLINE_MAX - prefix.length)}`;
}

/** What a link to this URL is, in the reader's words, when the proof's own
 *  text is too long to be a label. Read off the address and nothing else —
 *  a generated line invents no specifics. */
function labelForUrl(url: string): string {
  if (/\/mockups?\//.test(url)) return 'the mock';
  if (/\/docs?\//.test(url)) return 'the doc';
  if (/[?&]task=/.test(url) || /\/tasks\//.test(url)) return 'the task';
  const pr = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(url);
  if (pr) return `PR ${pr[1]}`;
  return 'the link';
}

/** Square brackets removed so a label cannot close its own markdown link. */
function plain(text: string): string {
  return text.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
}

/** The words a proof's link wears: its own text when that is short enough to
 *  be a label, else what the URL says it is. A multi-sentence note is never a
 *  label — the first generated mock items put a whole paragraph between the
 *  brackets, and the reader was handed a wall of text to tap. */
function linkLabel(proof: DoneWhenProof): string {
  const words = plain(proof.text);
  const oneSentence = firstSentence(words) === words;
  if (words !== '' && words.length <= LABEL_MAX && oneSentence) return words;
  return labelForUrl(proof.url ?? '');
}

/** One proof as a phrase: a link when it has one, else its words. */
function attachment(proof: DoneWhenProof): string {
  const words = plain(proof.text);
  if (isHttp(proof.url)) return `[${linkLabel(proof)}](${proof.url})`;
  return clipWords(words, LABEL_MAX * 2);
}

/**
 * The item for one owner line: the existing decision card with two options.
 *
 * The detail LEADS WITH THE LINK, on its own line. The reader's first act is
 * to open the thing being checked, and the first owner items put the proof in
 * a trailing "Proof:" list, or had none — "Where's the mock? \u2026 Link the mock
 * from the review item" (owner, 2026-09-14). Then the line itself, the proof's
 * own words as the context somebody away from the work needs, and one sentence
 * saying what each answer does. Nothing here is invented: every specific comes
 * from the line, its proof or the task's title.
 */
export function ownerCheckReview(
  task: Task,
  line: DoneWhenLine,
): { shape: 'decision'; headline: string; detail: string; options: unknown[] } {
  const proofs = (line.proof ?? []).slice(0, 3);
  const lead = proofs.find((p) => isHttp(p.url));
  const check = unpunctuated(line.text);
  // A REFUSED check has nothing for the agent to have opened, so "find it
  // first" would be a lie about why the reader is holding it. Say what
  // happened instead: the machine would not let the agent run the check.
  const refused = refusalProof(line);
  const opening = lead
    ? `Open [${linkLabel(lead)}](${lead.url}).`
    : refused
      ? OPENING_REFUSED
      : OPENING_NOTHING_LINKED;
  // The lead proof's own words, unless the label already said them. Not
  // possessive on the reporter's name: half the fleet's names end in s.
  const leadWords = lead ? plain(lead.text) : '';
  const note =
    lead !== undefined && leadWords !== '' && leadWords !== linkLabel(lead)
      ? ` The note attached with it: \u201c${sentence(clipWords(leadWords, NOTE_MAX))}\u201d`
      : '';
  // What the agent was refused, in its own words — unless the note above is
  // already those words, which it is when the refusal is the lead proof.
  const refusedWords = refused && refused !== lead ? plain(refused.text) : '';
  const refusedNote =
    refusedWords !== ''
      ? ` What it was refused: “${sentence(clipWords(refusedWords, NOTE_MAX))}”`
      : '';
  // The refusal is quoted above when it is quoted at all, so it is not also
  // listed as an attachment — one proof, said once.
  const also = proofs
    .filter((p) => p !== lead && !(refusedWords !== '' && p === refused))
    .map(attachment);
  const detail = [
    opening,
    '',
    `Check: ${check}.${note}${refusedNote}`,
    '',
    `${answersSentence(task, line)}${also.length > 0 ? ` Also attached: ${also.join('; ')}.` : ''}`,
  ].join('\n');
  return {
    shape: 'decision',
    headline: ownerCheckHeadline(line),
    detail,
    options: [
      {
        id: OWNER_CHECK_MET,
        label: 'Looks right',
        detail: MET_DETAIL,
      },
      {
        id: OWNER_CHECK_NOT_MET,
        label: 'Not met',
        detail: NOT_MET_DETAIL,
      },
    ],
  };
}

/**
 * The sentences of this line's card that the BOARD wrote, not the line's
 * reporter.
 *
 * The gate drops a hold's quote that falls inside one of these. The filer
 * cannot change them — the next sync writes the template again — so a hold
 * naming one asks for a fix nobody can make. The line's own words and its
 * proof are not here: those are the reporter's, and a hold may name them.
 */
export function ownerCheckBoilerplate(task: Task, line: DoneWhenLine): string[] {
  return [
    OPENING_REFUSED,
    OPENING_NOTHING_LINKED,
    answersSentence(task, line),
    MET_DETAIL,
    NOT_MET_DETAIL,
  ];
}

/**
 * Which line state a card was written from: a digest of the template's
 * headline and detail.
 *
 * Stored on the item (`StoredReviewItem.ownerTemplate`) each time the server
 * writes the template. A later sync whose template has the same key knows the
 * line's words and proof have not changed since, so different words on the
 * card are a revision somebody made on purpose — the filer answering a hold —
 * and are kept. FNV-1a, 32-bit: nothing is authorised by this value.
 */
export function ownerTemplateKey(words: { headline: string; detail: string }): string {
  const text = `${words.headline}\n${words.detail}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
