/**
 * The words a meeting is made of that carry no subject, and the small
 * functions that decide which is which.
 *
 * WHY IT IS IN `core`. Two packages ask the same question about the same
 * speech. The server asks it of a sentence, to judge whether the notes kept
 * an idea (`notes-idea-coverage.ts`); the board asks it of a row, to decide
 * whether an utterance is acknowledgement riding on the row it answered
 * (`meeting-transcript-fold.ts`). One vocabulary, because two lists of filler
 * words that disagree about which words are filler is a bug that reads as two
 * surfaces disagreeing about what was said.
 *
 * It moved here whole, prose included, from `notes-idea-coverage.ts`, which
 * re-exports every name so its own importers did not have to change.
 */

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
export const BACKCHANNEL_OPENER =
  /^(?:okay|ok|right|yeah|yep|yes|no|uh|um|er|ah|oh|sure|thanks|thank you|hi|hello|hey|good morning|good afternoon|alright|exactly|mhm|hmm)\b/i;

/**
 * Is this whole utterance acknowledgement and nothing else?
 *
 * "Yeah." "Okay, right." "Mm, sure, thanks." Every opener in `BACKCHANNEL` is
 * taken off the front in turn — a run of them is still a run of them — and
 * what remains has to carry no content word at all. So "Okay, the export
 * dialog drops the range" is not backchannel and "No." is.
 *
 * AT LEAST ONE OPENER HAS TO HAVE BEEN THERE. Having no content word left is
 * not enough on its own: the stoplist is built to strip the words that make
 * two ideas different, so it swallows a whole short sentence that is
 * nevertheless a decision — "We should go." is three stopwords and a full
 * stop. Acknowledgement is a vocabulary, not an absence.
 *
 * It lives here rather than beside its second caller because the stoplist and
 * the opener list are here, and the failure this repo has already had once is
 * two lists of filler words disagreeing about which words are filler. The raw
 * transcript's fold (`meeting-transcript-fold.ts`) asks this question about a
 * row; coverage asks it about a sentence; both get the same answer.
 */
export function isPureBackchannel(text: string): boolean {
  let rest = text.trim();
  let opened = false;
  for (;;) {
    const stripped = rest.replace(/^[^\p{L}\p{N}]+/u, '');
    const opener = BACKCHANNEL_OPENER.exec(stripped);
    if (!opener) {
      rest = stripped;
      break;
    }
    opened = true;
    rest = stripped.slice(opener[0].length);
  }
  if (!opened) return false;
  // `contentWords` tokenizes on `[a-z0-9]`, so a remainder written in a script
  // it cannot see comes back empty and would read as filler: "Yeah, 我不同意"
  // is a disagreement, not an acknowledgement. Any letter or digit left
  // outside that alphabet is content, whatever the stoplist knows about it.
  if (/[\p{L}\p{N}]/u.test(rest.replace(/[a-zA-Z0-9]/g, ''))) return false;
  return contentWords(rest).length === 0;
}

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
  // Both "e"s of "agree", so "agreed" (which "-ed" leaves "agre") meets it.
  while (base.length > 3 && base.endsWith('e')) base = base.slice(0, -1);
  return base;
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
    if (root !== null) return undoubled(root);
    // "need", "seed", "feed": a four-letter "-eed" word is its own root, so
    // it meets "needs" and "needed" rather than losing its "d" to "nee".
    return /^[^e]eed$/.test(w) ? w : (cut(1) ?? w);
  }
  // "-es" is only a two-letter plural after a sibilant ("batches", "boxes").
  // Everywhere else the "e" belongs to the word: "ranges" loses only its "s",
  // and the "e" goes with every other form's in `stem`.
  if (/(?:s|x|z|ch|sh)es$/.test(w) && cut(2) !== null) return cut(2) as string;
  // A plural is its singular's stem, whatever that singular ends in:
  // "hundreds" meets "hundred" and "speeds" meets "speed" only when the "s"
  // coming off hands the rest back through the rules above.
  if (w.endsWith('s') && !w.endsWith('ss')) {
    const singular = cut(1);
    return singular === null ? w : unsuffixed(singular);
  }
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
