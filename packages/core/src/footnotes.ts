/**
 * Inline footnotes: `^[a note]` written straight into a sentence, pandoc's
 * syntax.
 *
 * THE FILE IS THE TRUTH. A footnote is not a mark, a node or an attribute —
 * it is the literal characters `^[` … `]` sitting in the prose, exactly as
 * the author typed them. Everything else (the margin note beside the line,
 * the superscript on a phone, the printed sources list) is drawn from those
 * characters at render time and stored nowhere. That is what makes a doc
 * full of footnotes survive an edit and a flush byte for byte: the write-back
 * has nothing of its own to lose.
 *
 * What the parser DOES do with them (`prose-markdown.ts`) is refuse to look
 * inside: a note's body is emitted as one opaque run, so a `*` or a `[link]`
 * in a note is never read as emphasis and never re-serialized in a different
 * shape. Round-trip tests for that live in `prose-footnote-roundtrip.test.ts`.
 *
 * The three questions every renderer asks are answered here, once:
 * where the notes are, whether the author was sure, and which words the note
 * is about.
 */

/** One `^[…]` note found in a line of prose. */
export interface FootnoteSpan {
  /** Index of the `^` in the source text. */
  start: number;
  /** Index one past the closing `]`. */
  end: number;
  /** The note's body — what sits between the brackets. */
  note: string;
  /** True when the author marked the note as not yet confirmed. */
  unsure: boolean;
}

/** The character range a note is a note ABOUT. */
export interface FactRange {
  start: number;
  end: number;
}

/**
 * Every `^[…]` in `text`, in source order.
 *
 * Brackets nest, so a note may hold a markdown link (`^[see [the
 * guide](u)]`) and still come back as one note. An unterminated `^[` is not
 * a footnote at all — it stays literal text, the same answer the parser
 * gives an unpaired `*`.
 */
export function findFootnotes(text: string): FootnoteSpan[] {
  const out: FootnoteSpan[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    const end = footnoteEndAt(text, i);
    if (end < 0) continue;
    const note = text.slice(i + 2, end - 1);
    out.push({ start: i, end, note, unsure: isUnsureNote(note) });
    i = end - 1;
  }
  return out;
}

/**
 * Does a note START at `i`, and where does it end? Returns the index one past
 * its closing `]`, or -1 when `i` is not the `^` of a complete note.
 *
 * The inline parser walks a line character by character and asks this at each
 * position, which is why the question is asked in this shape rather than by
 * scanning the whole line for every character.
 */
export function footnoteEndAt(text: string, i: number): number {
  if (text[i] !== '^' || text[i + 1] !== '[') return -1;
  // `\\^[not a note]` is how an author writes the syntax down without using
  // it, the same escape that keeps a literal `*` from opening emphasis. A
  // doc explaining footnotes is full of them, and reading one as a note both
  // hides the characters the sentence is about and folds the explanation into
  // a margin caption.
  if (isEscaped(text, i)) return -1;
  const close = closingBracket(text, i + 1);
  return close < 0 ? -1 : close + 1;
}

/**
 * Is the character at `i` escaped?
 *
 * An ODD run of backslashes before it, because each pair is itself an escaped
 * backslash: `\\\\^[a note]` ends in a literal backslash and then a real note.
 */
function isEscaped(text: string, i: number): boolean {
  let n = 0;
  for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) n++;
  return n % 2 === 1;
}

/**
 * Index of the `]` that closes the `[` at `open`, or -1 when there is none.
 *
 * A backslash makes the next character literal, exactly as it does everywhere
 * else in markdown, and a literal bracket is not structure: `^[Form 3\] of
 * the appendix]` is ONE note whose text holds a `]`. Reading that escape as
 * the terminator truncated the note at the bracket and left ` of the
 * appendix]` sitting in the prose as unstyled text.
 */
function closingBracket(text: string, open: number): number {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') {
      j++;
      continue;
    }
    // A code span is characters, not structure, for the same reason an escape
    // is: ^[Use the `foo]bar` option.] is one note about a flag whose name
    // holds a bracket. Only a COMPLETE span is skipped — a lone backtick is
    // an ordinary character and must not swallow the rest of the note.
    if (c === '`') {
      const span = codeSpanEnd(text, j);
      if (span >= 0) {
        j = span;
        continue;
      }
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/**
 * The last backtick of the span opened at `open`, or -1 when nothing closes
 * it. A run of N backticks is closed by the next run of exactly N, which is
 * how a span holds a backtick of its own.
 */
function codeSpanEnd(text: string, open: number): number {
  let fence = 0;
  while (text[open + fence] === '`') fence++;
  for (let j = open + fence; j < text.length; j++) {
    if (text[j] !== '`') continue;
    let run = 0;
    while (text[j + run] === '`') run++;
    if (run === fence) return j + run - 1;
    j += run - 1;
  }
  return -1;
}

/**
 * Is this note one the author has not confirmed?
 *
 * The signal is the whole word "unconfirmed" anywhere in the note — usually
 * the last word ("… the department does not publish stage times.
 * Unconfirmed."). A word boundary on both sides, so "confirmed" is not a
 * match for a substring of itself.
 */
export function isUnsureNote(note: string): boolean {
  return /(^|\W)unconfirmed(\W|$)/i.test(note);
}

/**
 * The words a note at `footnoteStart` is about: the sentence it closes.
 *
 * Markdown says nothing about where a fact begins — only where the note
 * hangs — so the sentence is the one boundary the text actually carries. It
 * runs back to the end of the previous sentence, or to the end of the
 * previous note when that is later (two notes in one sentence get one clause
 * each rather than two overlapping copies of the sentence), and then past
 * the punctuation and the conjunction that join the clauses, so the range
 * starts on a word.
 */
export function factRange(text: string, footnoteStart: number): FactRange {
  const before = text.slice(0, footnoteStart);
  let start = 0;
  // A sentence may end inside a quotation or a parenthesis — `He said "It
  // works." The next claim` — so the closing marks come between the stop and
  // the space. Without them no boundary is found at all and the underline
  // starts back in the previous sentence.
  const sentence = /[.?!]["'”’)\]]*\s/g;
  for (let m = sentence.exec(before); m; m = sentence.exec(before)) {
    start = m.index + m[0].length;
  }
  for (const f of findFootnotes(before)) {
    if (f.end > start) start = f.end;
  }
  // The conjunction needs a boundary after it, or the group eats the first
  // syllable of an ordinary word: "And" out of "Android", "or" out of
  // "order", "but" out of "button", each leaving the underline starting
  // mid-word.
  const lead = /^[\s,;:—–-]*(?:(?:and|but|or|so|yet|nor)(?=\s|$))?\s*/i.exec(before.slice(start));
  start += lead?.[0].length ?? 0;
  let end = footnoteStart;
  while (end > start && /\s/.test(text[end - 1] ?? '')) end--;
  return { start, end };
}
