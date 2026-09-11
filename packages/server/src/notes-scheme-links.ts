/**
 * A citation the note-taker wrote as a SCHEME rather than as an address,
 * resolved against what the tick was given — or taken out.
 *
 * WHAT IT ANSWERS. The compose prompt hands this tick's matched rows as
 * `- [title](url)` and asks for a markdown link. It also teaches, two lines
 * above, that an inline mention of a voice is spelled `[@Name](speaker:LABEL)`
 * — a scheme and a NAME, not an address. A note-taker that generalises the
 * second shape over the first writes the row's title where a URL belongs, and
 * a live meeting produced exactly that: one note came out reading
 * `(task:Production cost target)`, as words, in the room's shared record.
 *
 * WHY NEITHER GATE BESIDE IT CATCHES ONE.
 *
 *   - `notes-invented-links.ts` judges a link's destination, and a markdown
 *     destination may not contain a space. `task:Production cost target` has
 *     two, so the inline-link pattern never matches it and the check never
 *     sees a link at all.
 *   - The doc's own inline parser is laxer than markdown and DOES read it,
 *     as a link whose href is `task:Production cost target`. A reader gets a
 *     label that opens nothing; the editor renders an unknown scheme with an
 *     empty href.
 *
 * So the two together turn a made-up citation into either dead words or a
 * dead link, and which one it is depends on whether the model wrote the
 * brackets. Both are the same fault and both are answered here.
 *
 * WHY IN THE APPLIER AND NOT IN THE PROMPT. Same answer as the module beside
 * it: the prompt already says to cite the URL it was handed, the model
 * already did not, and a rule the notes cannot survive breaking belongs where
 * the model's cooperation is not required.
 *
 * THE PRECISION RULE IS `notes-references.ts`'s, UNCHANGED: never link a
 * title the catalogue does not hold. A reference that resolves becomes the
 * real board link, so the reader taps it and lands on the row. One that does
 * not resolve is not guessed at and not left standing — the words stay and
 * the `task:` residue goes, because a reader cannot tell an invented citation
 * from a real one, and a parenthetical naming a row that may not exist is a
 * claim about the discussion that nobody asked for.
 */

import type { prose } from '@claude-workspaces/core';
import { referenceTokens } from './notes-references.ts';

/** One thing the tick was given, under the title it was given it by. */
export interface NoteLinkTarget {
  title: string;
  url: string;
  /**
   * Whether it is a board row or a doc, when the source that collected it
   * knew — and every source in `notesLinkSources` does.
   *
   * A citation names one or the other in its scheme, and a board may hold a
   * row and a doc under the SAME title (a ticket and the design doc it was
   * written from, which is the ordinary case, not a contrived one). Matching
   * on the title alone would then answer `doc:` with the row, or answer
   * whichever the catalogue happened to list first — a wrong link wearing a
   * right title, which is the one failure `notes-references.ts` is built to
   * refuse. Absent matches either scheme, for a caller that cannot say.
   */
  kind?: 'task' | 'doc';
  /** The row's own id, when the source carried one. A model that wrote the
   *  id instead of the title meant the same row. */
  id?: string;
}

/**
 * The two schemes rewritten here, and no others.
 *
 * They are the two the prompt's own reference list is made of — a board row
 * and a doc — so they are the two a note-taker writing a scheme instead of an
 * address reaches for. Every further guess (`ticket:`, `row:`) widens what a
 * parenthetical has to survive to stay in the notes, and the shape being
 * matched is prose as well as citation: this may delete an aside, so it is
 * kept to the words that are a citation and nothing else.
 *
 * `speaker:` is deliberately absent: it is this pipeline's own inline
 * mention, already gated per voice by `normalizeSpeakerTags`, and rewriting
 * one here would unwrap an attribution the meeting really made.
 */
const SCHEME = '(task|doc)';

/**
 * `[label](task:whatever)`, with the image form's `!` so `![a](task:x)`
 * cannot leave a stray mark where a picture was asked for.
 *
 * The destination admits spaces — which is the whole point: the shape this
 * exists for is not a legal markdown destination, so the pattern that judges
 * legal ones cannot be the pattern that finds it. It admits no NEWLINE, and
 * that is not decoration: `[^()]` spans them, so an unclosed `(task:` would
 * swallow every bullet after it up to the next `)` and rewrite unrelated
 * notes as one citation. A citation lives on one line.
 */
const BRACKETED = new RegExp(
  String.raw`!?\[([^\]\n]*)\]\([ \t]*${SCHEME}:[ \t]*([^()\n]*?)[ \t]*\)`,
  'gi',
);

/**
 * A bare `(task:Title)` aside, with the whitespace in front of it, so
 * dropping one leaves `cut the LCD.` rather than `cut the LCD .`.
 */
const PARENTHETICAL = new RegExp(
  String.raw`([ \t]*)\([ \t]*${SCHEME}:[ \t]*([^()\n]*?)[ \t]*\)`,
  'gi',
);

/** A title reduced to what two spellings of it share — the same tokens the
 *  reference matcher compares, so "the Goal bar" and "goal  bar" are one. */
function titleKey(text: string): string {
  return referenceTokens(text).join(' ');
}

/** The target `needle` names UNDER `scheme`, by title or by id, or nothing.
 *  Never a guess: an inexact title is no match, and neither is the right
 *  title of the wrong kind — which is what keeps a wrong row out. */
function resolve(
  scheme: string,
  needle: string,
  targets: readonly NoteLinkTarget[],
): NoteLinkTarget | undefined {
  const wanted = titleKey(needle);
  const id = needle.trim();
  if (wanted.length === 0) return undefined;
  const kind = scheme.toLowerCase() === 'doc' ? 'doc' : 'task';
  return targets.find(
    (t) =>
      (t.kind === undefined || t.kind === kind) &&
      (titleKey(t.title) === wanted || (t.id !== undefined && t.id === id)),
  );
}

/** What one tick's scheme citations came to. */
export interface SchemeLinkResult {
  /** The edits to apply, in order, every scheme citation resolved or gone. */
  edits: prose.BlockEdit[];
  /** The titles that resolved to a row, in the order they were written. */
  linked: string[];
  /** The citations taken out, as the model wrote them (`task:<title>`).
   *  Empty is the healthy state. */
  dropped: string[];
}

/**
 * Rewrite every `task:`-style citation in `edits` into the link it meant, or
 * take it out.
 *
 * An edit with no markdown passes through untouched, and an edit that carries
 * no such citation comes back as the same object, so the ordinary tick is not
 * rewritten.
 */
export function resolveSchemeLinks(
  edits: readonly prose.BlockEdit[],
  targets: readonly NoteLinkTarget[],
): SchemeLinkResult {
  const linked: string[] = [];
  const dropped: string[] = [];
  const out = edits.map((edit) => {
    if (!('markdown' in edit)) return edit;
    let markdown = edit.markdown.replace(
      BRACKETED,
      (_whole: string, label: string, scheme: string, needle: string) => {
        const hit = resolve(scheme, needle, targets);
        // The label is what a reader sees, so it is what survives either
        // way; an empty one falls back to the words the model cited.
        const text = label.trim().length > 0 ? label : (hit?.title ?? needle);
        if (!hit) {
          dropped.push(`${scheme}:${needle}`);
          return text;
        }
        linked.push(hit.title);
        return `[${text}](${hit.url})`;
      },
    );
    markdown = markdown.replace(
      PARENTHETICAL,
      (_whole: string, space: string, scheme: string, needle: string) => {
        const hit = resolve(scheme, needle, targets);
        if (!hit) {
          // THE WHOLE ASIDE GOES, not just the scheme. What is left of one
          // of these is the row's title in brackets — a parenthetical naming
          // work that may not exist, which is the claim this is here to
          // refuse, and the sentence around it was composed to stand without
          // it. The bracketed form keeps its label because there the words
          // and the citation are different text.
          dropped.push(`${scheme}:${needle}`);
          return '';
        }
        linked.push(hit.title);
        // The parentheses stay: the sentence was written around an aside,
        // and a citation spliced into it bare reads as part of the prose.
        return `${space}([${hit.title}](${hit.url}))`;
      },
    );
    return markdown === edit.markdown ? edit : { ...edit, markdown };
  });
  return { edits: out, linked, dropped };
}
