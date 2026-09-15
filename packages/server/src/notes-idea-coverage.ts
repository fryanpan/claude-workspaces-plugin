/**
 * Did the notes actually keep what was said? Ideas in, ideas accounted for.
 *
 * WHY TURNS WERE THE WRONG UNIT. A meeting reported `turnsLost: 0` while a
 * whole minute of conversation about one subject produced no note. Both facts
 * were true: every turn reached a compose, and the compose chose to write
 * nothing about any of them. `turnsComposed` counts what the note-taker was
 * SHOWN, which is a fact about the pipeline; a reader of the notes is asking
 * about what the note-taker KEPT, which is a fact about the notes. So this
 * module counts the second thing, and `NotesMeetingSummary` now reports both.
 *
 * WHAT AN IDEA IS HERE. One sentence of settled speech carrying enough
 * content to be worth a note — see `extractIdeas`. Not a clause, not a turn:
 * a turn can hold three subjects and a backchannel can hold none, and the
 * sentence is the smallest unit a person would say "that never made it into
 * the notes" about.
 *
 * THE CHECK IS LEXICAL AND THAT IS DELIBERATE. Asking a model whether each
 * idea survived would double the cost of every tick to answer a question
 * nobody reads while the meeting is fine, so the runtime check is content-word
 * overlap between the idea and the notes as they now stand. It is a PROXY,
 * and its errors are asymmetric on purpose: a paraphrase this cannot
 * recognise costs one retry, which is cheap and self-correcting, while an
 * idea it wrongly calls carried is silently counted covered. The second
 * failure is the one that matters, so the threshold is set low enough that
 * over-counting a miss is the common error — and the eval's model judge
 * (`scripts/notes-eval-ideas.ts`) is what measures the real rate over a
 * corpus, with this number beside it rather than in place of it.
 *
 * THE LEDGER RETRIES ONCE. An idea the notes do not carry after the tick that
 * heard it is put back into the NEXT tick's speech, once. A note-taker that
 * filtered it out under time pressure gets a second look at it with the
 * notes-so-far in front of it; one that filtered it out on purpose filters it
 * out again, and the second miss is counted LOST rather than retried forever.
 * One retry, not three, because the words are re-sent in the prompt and an
 * unbounded queue of them is the uncapped carry-forward that once grew a
 * meeting's prompt without limit (see `beginNotesSession`).
 *
 * A SETTLE IS PROVISIONAL UNTIL THE COMPOSE LANDS. The retries a settle hands
 * back ride on the next compose, and that compose can throw or have its write
 * refused — in which case the words carry forward and the note-taker never
 * answered them. Counting the attempt anyway spent the idea's one retry on a
 * tick that produced no notes, and the tick after it read the same miss as a
 * SECOND miss and counted the idea lost. So `settle` journals what it did and
 * the caller says which way it went: `composed()` keeps the verdicts,
 * `composeFailed()` puts them back exactly as they were.
 */

import type { NotesTurn } from './meeting-notes.ts';

/**
 * How much of an idea's content has to show up in the notes before it counts
 * as carried.
 *
 * Notes paraphrase, so an exact-words test would report every good note as a
 * miss. Two fifths is what survives paraphrase in practice: a bullet about a
 * sentence keeps its nouns and its numbers and throws away its verbs and its
 * hedging. Raising it makes the retry noisy; lowering it makes an unrelated
 * bullet about the same topic look like coverage, which is the error this
 * must not make quietly.
 */
export const IDEA_CARRIED_SHARE = 0.4;

/**
 * The fewest content words a sentence needs before it is an idea at all.
 *
 * "Right." and "Yeah, exactly" are not ideas and never will be. Two is as low
 * as it goes and it is low on purpose: the prompt now says a brief important
 * sentence stays, so the floor has to sit UNDER the shortest sentence worth a
 * note, and "we ship Tuesday" is two content words. Three read that sentence
 * as packaging, which is the exact mistake this whole change is about.
 *
 * The cost of two is that a little filler is counted as an idea and retried
 * once. That is the cheap direction: a retry costs a few tokens, while an
 * idea silently counted covered is the failure nobody can see.
 */
export const MIN_IDEA_CONTENT_WORDS = 2;

/** One thing said that the notes owe an answer to. */
export interface SpokenIdea {
  /** The settled turn it came out of. */
  turn: number;
  /** The sentence, as spoken. This is what a retry re-sends. */
  text: string;
  /** Who said it, when the session knew. Carried so a retry keeps its voice. */
  speaker?: string;
  /** The engine label behind that name, for the same reason. */
  speakerLabel?: string;
  /** Its content words, stemmed — what the notes are searched for. */
  keywords: readonly string[];
}

/**
 * Words that carry no subject.
 *
 * Deliberately short. A long stoplist starts deleting the words that make one
 * idea different from another ("cost", "user", "next"), and the check then
 * reports two unrelated sentences as the same idea.
 */
const STOPWORDS = new Set(
  (
    'a an the and or but so then than that this these those there here it its is are was were be ' +
    'been being am do does did doing have has had having i you he she we they me him her us them ' +
    'my your his their our of to in on at by for with from about into over after before as if ' +
    'when while can could would should will shall may might must not no yes okay ok right yeah ' +
    'yep uh um er ah oh like just really very much more most some any all one two also well now ' +
    'get got go going come came say said says think thought know knew mean means kind sort thing ' +
    'things stuff bit lot maybe actually basically obviously anyway sure gonna wanna let lets ' +
    'nothing something anything everything because up down out off again still even only other ' +
    'exactly totally definitely fine great good cool guess suppose seems looks sound sounds ' +
    'saw see seen same want need make made'
  ).split(' '),
);

/**
 * Openers that make a whole sentence packaging rather than content.
 *
 * Only matched at the START of a sentence and only when what follows adds no
 * content words of its own, so "Okay, the export dialog drops the range" is
 * an idea and "Okay, right, yeah" is not.
 */
const BACKCHANNEL =
  /^(?:okay|ok|right|yeah|yep|yes|no|uh|um|er|ah|oh|sure|thanks|thank you|hi|hello|hey|good morning|good afternoon|alright|exactly|mhm|hmm)\b/i;

/**
 * A word reduced to the part a paraphrase keeps.
 *
 * Crude stemming — plurals, past tense, gerunds — because the notes say
 * "loses the range" about speech that said "losing the range", and a check
 * that cannot see through that reports every good note as a miss. It is not a
 * linguist's stemmer and does not need to be: both sides go through it, so a
 * wrong stem is wrong the same way twice.
 *
 * But only when both sides take the SAME wrong turn, and a word's forms did
 * not (2026-09-14). "estimate" and "estimates" kept the final "e" that
 * "estimated" and "estimating" lose, so a take-back saying "the estimated
 * hours" shared no word with a correction saying "hour estimates", and the
 * withdrawn note stayed beside it. So the final "e" goes from every form,
 * and so does the consonant "stopped" doubles; the price is that a few
 * different words meet ("plane" and "plan"), which a share of several words
 * absorbs.
 */
export function stem(word: string): string {
  const w = word.toLowerCase();
  let base = unsuffixed(w);
  // "status" and "statuses", "menu" and "menus": a singular can end in "us"
  // or "is" and a plural can too, so the one "s" either keeps goes from both.
  if (base.length > 3 && /[iu]s$/.test(base)) base = base.slice(0, -1);
  return base.length > 3 && base.endsWith('e') ? base.slice(0, -1) : base;
}

/** `w` with one inflectional suffix taken off, leaving at least three letters. */
function unsuffixed(w: string): string {
  const cut = (n: number): string | null => (w.length - n >= 3 ? w.slice(0, w.length - n) : null);
  if (/ie[sd]$/.test(w) && cut(3) !== null) return `${cut(3)}y`;
  // A two-letter root before "-ing" is a short word that lost its "e"
  // ("using", "owing") when it has a vowel, and no root ("bring") when not.
  if (w.endsWith('ing')) {
    const root = cut(3);
    if (root !== null) return undoubled(root);
    return /^[^aeiou]*$/.test(w.slice(0, -3)) ? w : `${w.slice(0, -3)}e`;
  }
  // "-d" alone is the past tense of a word ending in "e" ("used"); longer
  // words reach the same stem through "-ed" and the final "e" going.
  if (w.endsWith('ed')) {
    const root = cut(2);
    return root !== null ? undoubled(root) : (cut(1) ?? w);
  }
  // "-es" is only a two-letter plural after a sibilant ("batches", "boxes").
  // Everywhere else the "e" belongs to the word: "ranges" loses only its "s",
  // and the "e" goes with every other form's in `stem`.
  if (/(?:s|x|z|ch|sh)es$/.test(w) && cut(2) !== null) return cut(2) as string;
  if (w.endsWith('s') && !w.endsWith('ss')) return cut(1) ?? w;
  return w;
}

/**
 * A root with the consonant English doubles before "-ed" and "-ing" taken
 * back off: "stopped" is "stop". Only after one of those suffixes, and never
 * an s, l, f or z, which a word doubles itself — "pass", "fall", "staff" and
 * "buzz" keep theirs, so "passed" is "pass". The price is the spellings that
 * double an l before a suffix ("labelled" stays "labell").
 */
function undoubled(root: string): string {
  return root.length > 3 && /([bcdghjkmnpqrtvwxy])\1$/.test(root) ? root.slice(0, -1) : root;
}

/** The content words of a piece of text, stemmed and deduplicated. */
export function contentWords(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    if (STOPWORDS.has(raw)) continue;
    if (raw.length < 3 && !/^\d+$/.test(raw)) continue;
    out.add(stem(raw));
  }
  return [...out];
}

/** A word that turns a statement into its opposite. `contentWords` drops
 *  every one of these as a stopword. */
const NEGATION =
  /\b(?:not|no|never|none|nothing|nobody|neither|nor|cannot|without)\b|n['\u2019]t\b/gi;

/**
 * Whether `text` says the opposite of what its content words say: an odd
 * number of negations. Two notes that share every content word and differ
 * here are opposite facts, not one fact twice — "the crane is safe" and "the
 * crane is not safe".
 */
export function negates(text: string): boolean {
  return (text.match(NEGATION)?.length ?? 0) % 2 === 1;
}

/**
 * Speech cut into sentences.
 *
 * The engine punctuates a settled turn, so a full stop is a real boundary
 * here rather than a guess. A turn with no punctuation at all — which a
 * partial is, and which is what the final pass carries — stays whole: one
 * long idea is a better unit than a sentence split on nothing.
 */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The ideas in a tick's speech.
 *
 * A sentence is an idea when it has `MIN_IDEA_CONTENT_WORDS` content words
 * left after the stoplist, and is not pure backchannel. Everything else is
 * packaging — which the prompt now says to cut, so counting it as an idea the
 * notes owe would mark the note-taker down for obeying its instructions.
 */
export function extractIdeas(turns: readonly NotesTurn[]): SpokenIdea[] {
  const ideas: SpokenIdea[] = [];
  for (const turn of turns) {
    for (const sentence of sentencesOf(turn.text)) {
      const keywords = contentWords(sentence);
      if (keywords.length < MIN_IDEA_CONTENT_WORDS) continue;
      if (BACKCHANNEL.test(sentence) && keywords.length < MIN_IDEA_CONTENT_WORDS + 1) continue;
      ideas.push({
        turn: turn.turn,
        text: sentence,
        ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
        ...(turn.speakerLabel !== undefined ? { speakerLabel: turn.speakerLabel } : {}),
        keywords,
      });
    }
  }
  return ideas;
}

/** Does this set of notes carry that idea? See `IDEA_CARRIED_SHARE`. */
export function ideaCarried(idea: SpokenIdea, notes: string): boolean {
  if (idea.keywords.length === 0) return true;
  const inNotes = new Set(contentWords(notes));
  const hits = idea.keywords.filter((k) => inNotes.has(k)).length;
  // A two-word idea has no room for a share: either the notes name both of
  // the things it was about or they are about something else.
  if (idea.keywords.length <= 2) return hits === idea.keywords.length;
  return hits >= Math.max(2, Math.ceil(idea.keywords.length * IDEA_CARRIED_SHARE));
}

/** What a meeting's ideas came to. */
export interface IdeaCoverage {
  /** Distinct ideas the settled speech contained. */
  seen: number;
  /** Ideas the notes were found to carry. */
  carried: number;
  /** Ideas re-sent because the first attempt produced no note. */
  retried: number;
  /** Ideas still missing after their retry. The number this exists for. */
  lost: number;
}

export interface IdeaLedger {
  /** This tick's speech. Its ideas become pending. */
  see(turns: readonly NotesTurn[]): void;
  /**
   * Settle every pending idea against the notes as they now stand, and return
   * the ones to put back into this tick's speech. An idea missing for the
   * second time is counted lost and never returned again.
   */
  settle(notes: string): readonly SpokenIdea[];
  /**
   * The compose that was handed the last settle's retries succeeded. Its
   * verdicts stand.
   */
  composed(): void;
  /**
   * It did not — the compose threw, or the doc refused the write. The last
   * settle's verdicts are undone, because an idea whose second look was
   * never written cannot be said to have had one.
   */
  composeFailed(): void;
  /** The last settle of the meeting: nothing is retried, so what is still
   *  missing is lost. */
  close(notes: string): void;
  /**
   * Ideas still waiting on a verdict.
   *
   * Read so the caller can skip the final outline read when there is nothing
   * to judge: a meeting whose every idea already settled must not pay a doc
   * read — and must not emit one — merely to close a ledger that is empty.
   */
  readonly pending: number;
  readonly coverage: IdeaCoverage;
}

/** One idea, plus whether it has already had its second chance. */
interface Pending {
  idea: SpokenIdea;
  retried: boolean;
}

/**
 * One reversible thing the last settle did.
 *
 * Only the two verdicts that depend on the NEXT compose are here. A carried
 * idea is a fact about notes that are already written, so it is committed as
 * it is found and never appears in a journal.
 */
type Undo =
  | { kind: 'retried'; k: string; entry: Pending }
  | { kind: 'lost'; k: string; entry: Pending };

/**
 * The per-meeting ledger.
 *
 * Pending ideas are keyed by their own text so a retried sentence, which is
 * re-sent through the composer and would otherwise be extracted a second
 * time, stays ONE idea. Counting it twice would make a retry improve the
 * denominator, which is the shape of every metric that measures its own
 * mitigation.
 */
export function createIdeaLedger(): IdeaLedger {
  const pending = new Map<string, Pending>();
  const known = new Set<string>();
  const coverage: IdeaCoverage = { seen: 0, carried: 0, retried: 0, lost: 0 };
  let journal: Undo[] = [];

  const key = (idea: SpokenIdea): string => idea.text.trim().toLowerCase();

  return {
    coverage,
    get pending(): number {
      return pending.size;
    },
    see(turns) {
      for (const idea of extractIdeas(turns)) {
        const k = key(idea);
        if (known.has(k)) continue;
        known.add(k);
        coverage.seen++;
        pending.set(k, { idea, retried: false });
      }
    },
    settle(notes) {
      // A settle that follows an unresolved one has no way to undo the older
      // journal, so the older one stands. Losing the ability to roll back is
      // better than rolling back to a state two composes old.
      journal = [];
      const retry: SpokenIdea[] = [];
      for (const [k, entry] of [...pending]) {
        // Whether the NOTES carry it is a fact about the notes, settled
        // whatever the next compose does, so it is never journalled.
        if (ideaCarried(entry.idea, notes)) {
          coverage.carried++;
          pending.delete(k);
          continue;
        }
        if (entry.retried) {
          coverage.lost++;
          pending.delete(k);
          journal.push({ kind: 'lost', k, entry });
          continue;
        }
        entry.retried = true;
        coverage.retried++;
        journal.push({ kind: 'retried', k, entry });
        retry.push(entry.idea);
      }
      return retry;
    },
    composed() {
      journal = [];
    },
    composeFailed() {
      for (const undo of journal.reverse()) {
        if (undo.kind === 'lost') {
          coverage.lost--;
          pending.set(undo.k, undo.entry);
        } else {
          coverage.retried--;
          undo.entry.retried = false;
        }
      }
      journal = [];
    },
    close(notes) {
      journal = [];
      for (const [k, entry] of [...pending]) {
        if (ideaCarried(entry.idea, notes)) coverage.carried++;
        else coverage.lost++;
        pending.delete(k);
      }
    },
  };
}
