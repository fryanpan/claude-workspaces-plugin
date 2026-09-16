/**
 * What a hold is allowed to SAY — the pure half of the rule that a hold
 * diagnoses and never drafts.
 *
 * The gate used to answer a hold with the sentence it wanted added, written
 * out ready to paste. Four of those sentences, read by the owner across five
 * boards on 2026-09-14, carried a specific the item's source does not
 * support: a range quoted as a point figure, a top-decile statistic given as
 * the median, a mechanism nobody had read anywhere. The judge cannot see the
 * source — it is handed a headline, a detail and some options — so any
 * specific it supplies is one it invented, and a hold that supplies one is
 * teaching the filer to invent too: a fabricated figure reads as more
 * responsive to "be concrete" than a vague truth does.
 *
 * So the draft is gone, and what is left has to be checked rather than
 * trusted. This module is the check. It is pure and lives in core beside the
 * prompt for the same reason the prompt does: the wording of the ask and the
 * bounds on the answer are asserted without a key or a socket.
 */

/**
 * The one instruction every hold ends with.
 *
 * A hold names a gap and stops. What the filer does about it is go back to
 * the thing the item was written from — the log, the transcript, the diff,
 * the page — and read it again. Saying so is what stops the filer reasoning
 * a specific into existence at the desk, which is what the revision loop was
 * measured selecting for.
 */
export const REVIEW_HOLD_REREAD =
  'Re-read the source this item was written from and answer from what it says. Do not supply a figure, name or mechanism the source does not carry — if the honest answer is less specific than this asks for, say so and why.';

/**
 * What a hold says when the judge's own diagnosis carried a specific the item
 * does not contain.
 *
 * The diagnosis is dropped whole rather than patched: a sentence with an
 * invented number in it is a sentence about an item that does not exist, and
 * there is no way to tell from here which half of it was about the real one.
 */
export const REVIEW_HOLD_UNUSABLE_REASON =
  'The gate could not put its concern in words that stay inside what this item says';

/**
 * Every FIGURE in `text`, normalized.
 *
 * A figure is a whole numeric expression — `02:00`, `1,200`, `3.5`, the `2`
 * of `2GB` — not each maximal run of digits inside it. That distinction is
 * the check, not a detail of it: reading runs, an item carrying `2GB` and
 * `07:30` would license a hold about `30GB` or `2:30`, because every run in
 * those was present somewhere. Neither figure is in the item, and admitting
 * them is exactly the invented specific this module exists to stop (codex
 * review).
 *
 * Grouping commas are stripped, so `1,200` and `1200` are one figure written
 * two ways; a trailing separator is not part of the figure, so the `02:00` in
 * "at 02:00, the sync" does not become `02:00,`.
 */
export function numberTokens(text: string): string[] {
  const raw = text.match(/\d[\d.,:]*\d|\d/g) ?? [];
  return raw.map((t) => t.replace(/[.,:]+$/, '').replace(/,/g, ''));
}

/**
 * Figures spelled as words, canonicalised — "forty-five" and "45" are one
 * figure.
 *
 * The list starts at ELEVEN, and the omission is deliberate rather than
 * lazy. "one", "two" and "half" are ordinary English words a correct hold
 * uses constantly — "no option says what choosing one costs" — and a reason
 * carrying an invented figure is dropped WHOLE, so counting them would
 * silence far more real diagnoses than fabrications. Eleven upward, the tens
 * and the scale words are the range where a word is a quantity and almost
 * never anything else, which is the range the measured inventions sat in
 * (codex review: "the rebuild takes forty-five minutes").
 */
const SPELLED: Record<string, string> = {
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  sixty: '60',
  seventy: '70',
  eighty: '80',
  ninety: '90',
  hundred: '100',
  thousand: '1000',
  million: '1000000',
  billion: '1000000000',
};

/** Every spelled-out figure in `text`, as the digits it means. A hyphenated
 *  compound is read as its parts, so "forty-five" contributes the `40` that
 *  makes it a figure and an item saying neither is not licensing it. */
export function spelledNumbers(text: string): string[] {
  const out: string[] = [];
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    const n = SPELLED[word];
    if (n !== undefined) out.push(n);
  }
  return out;
}

/**
 * Does `text` carry a figure the item does not?
 *
 * The test a hold has to pass before it is shown. It is deliberately about
 * FIGURES and not about words: "twice" in a hold is the gate counting its own
 * holds, and that is a fact this code holds rather than one the judge made
 * up.
 */
export function hasNumberNotIn(text: string, itemText: string): boolean {
  const allowed = new Set([...numberTokens(itemText), ...spelledNumbers(itemText)]);
  return [...numberTokens(text), ...spelledNumbers(text)].some((n) => !allowed.has(n));
}

/**
 * A stable, opaque id for the GAP a hold is about.
 *
 * Used for one thing only: a filer who has answered a hold with "the source
 * is less specific than that" must not be asked for the same thing again,
 * and must still be holdable for something else. The key is derived from the
 * judge's RAW sentence, normalized for case, punctuation and spacing — a
 * repeat of a demand is the judge saying the same sentence again, which is
 * precisely the shape the measured loop took.
 *
 * Two things it is deliberately not, and each closes a defect found in
 * review:
 *
 *  - not the STORED reason. A diagnosis carrying an invented figure is
 *    replaced whole by `REVIEW_HOLD_UNUSABLE_REASON` before it is recorded,
 *    so every such hold would share one identity and one answered gap would
 *    exempt every later numeric concern.
 *  - not the raw sentence itself. That sentence is the invented text; keeping
 *    it on disk and on the wire would put it one careless render away from a
 *    reader. A digest compares equal and shows nothing.
 *
 * Deliberately NOT fuzzy. A near-match rule would decide, on a similarity
 * score nobody can read, that a real new defect was the old one; the failure
 * this bounds is a gate that repeats itself, and an exact repeat is what that
 * looks like.
 */
export function holdGapKey(reason: string): string {
  const flat = reason
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  // FNV-1a, 32-bit. Not a security boundary — nothing is authorised by this
  // value; it decides only whether the gate is repeating itself.
  let h = 0x811c9dc5;
  for (let i = 0; i < flat.length; i++) {
    h ^= flat.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Whitespace collapsed, for comparing a quoted phrase against words that
 *  may have been wrapped differently. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Everything the judge was shown about the item, as one string to check a
 *  verdict against — headline, detail and every option's words. */
export function judgedText(item: {
  headline?: string;
  detail?: string;
  options?: ReadonlyArray<{ label?: string; detail?: string }>;
}): string {
  const parts = [item.headline ?? '', item.detail ?? ''];
  for (const o of item.options ?? []) parts.push(o.label ?? '', o.detail ?? '');
  return parts.join(' ');
}

export interface HoldWords {
  /** The gap, in the judge's words. */
  reason: string;
  /** The item's OWN words the gap is about, copied out of it verbatim.
   *  Absent when the judge quoted nothing, or quoted something the item does
   *  not actually say. */
  quote?: string;
}

/**
 * The judge's hold, with everything it could not have known removed.
 *
 * Two rules, and each one closes a defect that was seen live:
 *
 *  - a quote that is not in the item is dropped. A judge that paraphrases
 *    while claiming to quote hands the filer words to search for that are not
 *    there, which is the same dead end as naming the wrong field.
 *  - a reason carrying a digit the item does not carry is replaced whole.
 *    That is the invented specific, arriving in the diagnosis rather than in
 *    a draft.
 *
 * Nothing here is a judgement about whether the hold is RIGHT. It is a bound
 * on what the hold may contain, which is the only thing this side can check.
 */
export function boundHoldWords(words: HoldWords, itemText: string): HoldWords {
  const flatItem = flat(itemText);
  const quote = words.quote === undefined ? undefined : flat(words.quote);
  const keptQuote =
    quote !== undefined && quote !== '' && flatItem.includes(quote) ? quote : undefined;
  const reason = hasNumberNotIn(words.reason, itemText)
    ? REVIEW_HOLD_UNUSABLE_REASON
    : words.reason;
  return keptQuote === undefined ? { reason } : { reason, quote: keptQuote };
}

/** How many holds, as a sentence says it. Words to three, because a hold
 *  count on a card is prose and not a measurement. */
export function holdCountWord(holds: number): string {
  if (holds === 1) return 'once';
  if (holds === 2) return 'twice';
  if (holds === 3) return 'three times';
  return `${holds} times`;
}

/**
 * What the READER is told about an item's history with the gate, when there
 * is anything to tell.
 *
 * A derived, card-shaped view of `ReviewItemJudgement` rather than the
 * judgement itself: the queue row is what the browser gets, and handing it a
 * whole verdict would put the judge's internal reasons — including the ones
 * a later round contradicted — on a surface written for the person answering
 * the question.
 */
export interface ReviewGateNote {
  /** How many times these words were held before the reader saw them. */
  holds: number;
  /** How it reached the reader without the judge passing it, when that is
   *  how it got here. See `ReviewItemJudgement.admitted`. */
  admitted?: 'holds' | 'less-specific';
  /** The filer's own words for why the honest answer is less specific than
   *  the gate asked for. Shown verbatim. */
  lessSpecific?: string;
}

/**
 * The note for a stored verdict, or `undefined` when the item has nothing to
 * say — never held, never admitted, which is the ordinary item and the one
 * whose card should carry no gate furniture at all.
 */
export function gateNoteOf(
  judge:
    | { heldFor?: string[]; admitted?: 'holds' | 'less-specific'; lessSpecific?: string }
    | undefined,
): ReviewGateNote | undefined {
  const holds = judge?.heldFor?.length ?? 0;
  if (holds === 0 && judge?.admitted === undefined) return undefined;
  return {
    holds,
    ...(judge?.admitted !== undefined ? { admitted: judge.admitted } : {}),
    // The note is shown ONLY when it is why the item got through. A filer may
    // send it with a revision the judge then passes on its merits, and the
    // stored verdict keeps it either way — but a card that says "the filer
    // revised it and it passed" while quoting an explanation of what the
    // source cannot support is telling the reader two different stories about
    // the same item (codex review).
    ...(judge?.admitted === 'less-specific' &&
    judge?.lessSpecific !== undefined &&
    judge.lessSpecific !== ''
      ? { lessSpecific: judge.lessSpecific }
      : {}),
  };
}
