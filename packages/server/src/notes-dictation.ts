/**
 * A speaker dictating the shape of a document, noticed per tick and named in
 * the prompt.
 *
 * WHY THE PROMPT RULE WAS NOT ENOUGH. The shipped instructions ask for a
 * dictated layout ("page one is… start with… then… the last thing…") to
 * come out as a numbered list under a heading in the speaker's words. Played
 * tick by tick through the production model on a synthetic dictation, the
 * rule held on no tick at all: every item came back as a dash bullet, two
 * items were filed under topic headings of the model's own, and the regroup
 * directive then nested the page's items into groups. Each tick carries one
 * sentence, and "Then the cost per block" read alone is a note about cost,
 * not the second item of page one. So, as with regrouping
 * (`notes-regroup-ask.ts`), the server does the noticing and the prompt names
 * the heading id and the number.
 *
 * WHEN IT FIRES, and why it is narrow. A PAGE cue is a sentence that OPENS
 * with a page and says what it is ("Page two is the flooding", "Part one:
 * the streets"); "page two is loading slowly" and "on page two of the
 * report" do not qualify. An ITEM cue is a sentence opening with an ordering
 * word ("start with", "then", "next", "the last thing") — words ordinary
 * meetings use all the time, so an item cue only counts while the speaker is
 * dictating: a page cue, or an item cue that itself counted, within the last
 * `DICTATION_WINDOW` ticks (`createDictationMemory`). A page heading existing
 * somewhere in the doc does not keep dictation open, and a tick with no cue
 * gets no block at all. A meeting nobody dictated never sees this block.
 */

import { prose } from '@claude-workspaces/core';
import * as Y from 'yjs';
import { sentencesOf } from './notes-idea-coverage.ts';

const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten';
const NUMBERS = NUMBER_WORDS.split('|');

/** A page number as digits, whichever way it was written: "two" and "2" are "2". */
export function pageNumber(word: string): string {
  const at = NUMBERS.indexOf(word.toLowerCase());
  return at >= 0 ? String(at + 1) : word;
}

/** The page a heading names ("Page two: the flooding" is "2"), or undefined. */
export function pageOfHeading(text: string): string | undefined {
  const n = PAGE_HEADING.exec(text.trim())?.[1];
  return n === undefined ? undefined : pageNumber(n);
}

/**
 * "Page two is the flooding", "Part one: the streets". The sentence has to
 * OPEN with the page, and what follows has to introduce what the page is:
 * "section 3 is wrong" and "page two is loading slowly" name a page in
 * ordinary talk and open nothing.
 */
const PAGE_CUE = new RegExp(
  `^(?:(?:and|so|okay|ok|right)[,\\s]+)?(?:page|part|section)\\s+(${NUMBER_WORDS}|\\d+)\\s*` +
    '(?::|(?:is|will be) (?:the|about|on|for|called|our|all about)\\b|covers\\b)',
  'i',
);
/** A heading that names a dictated page: "Page two: the flooding". */
const PAGE_HEADING = new RegExp(`^(?:page|part|section)\\s+(${NUMBER_WORDS}|\\d+)\\b`, 'i');
/** A sentence that places the next item of a dictated list. */
const ITEM_CUE =
  /^(?:(?:and|so|okay|ok)[,\s]+)?(?:start(?:ing)? with|first(?:ly)?,|then\b|next\b|after that|the (?:last|final) (?:thing|item|part|step)|last(?:ly)?,|finally)/i;
/** "It has two pages": the speaker counting pages before naming any. */
const PAGE_COUNT = new RegExp(
  `\\b(?:has|have|in)\\s+(?:${NUMBER_WORDS}|\\d+)\\s+(?:pages|parts|sections)\\b`,
  'i',
);
/** "…on page one…", which says which page an item belongs to. */
const ON_PAGE = new RegExp(`\\bon (?:page|part|section)\\s+(${NUMBER_WORDS}|\\d+)\\b`, 'i');

/** One sentence of this tick that dictates layout. */
export interface DictationCue {
  kind: 'page' | 'item' | 'count';
  sentence: string;
  /** The page it names, as digits ("2"), when it names one. */
  page?: string;
}

/** The sentences of a tick's speech that dictate a layout. */
export function dictationCues(turns: readonly { text: string }[]): DictationCue[] {
  const out: DictationCue[] = [];
  for (const turn of turns) {
    for (const sentence of sentencesOf(turn.text)) {
      if (ITEM_CUE.test(sentence)) {
        const on = ON_PAGE.exec(sentence)?.[1];
        const page = on === undefined ? undefined : pageNumber(on);
        out.push({ kind: 'item', sentence, ...(page ? { page } : {}) });
        continue;
      }
      const named = PAGE_CUE.exec(sentence)?.[1];
      const page = named === undefined ? undefined : pageNumber(named);
      if (page) out.push({ kind: 'page', sentence, page });
      else if (PAGE_COUNT.test(sentence)) out.push({ kind: 'count', sentence });
    }
  }
  return out;
}

/** The page headings in the doc, in order. */
function pageHeadings(outline: readonly prose.OutlineEntry[]): prose.OutlineEntry[] {
  return outline.filter((e) => e.kind === 'heading' && PAGE_HEADING.test(e.text));
}

const pageOf = (heading: prose.OutlineEntry): string | undefined => pageOfHeading(heading.text);

/** A page heading that is only its number: opened, not yet named. */
const BARE_PAGE_HEADING = new RegExp(
  `^(?:page|part|section)\\s+(?:${NUMBER_WORDS}|\\d+)[.:]?$`,
  'i',
);

/**
 * The page the speaker is on: the last page heading already named in their
 * words, or the first page when none is named yet. NOT the last page heading
 * in the doc: a note-taker told "it has two pages" often opens "Page 1" and
 * "Page 2" at once, and sending the first page's items to the last heading
 * filed all of page one under page two on the synthetic dictation. Undefined
 * once the notes have moved on past the pages to a heading of another kind.
 */
function currentPage(outline: readonly prose.OutlineEntry[]): prose.OutlineEntry | undefined {
  const pages = pageHeadings(outline);
  const page = pages.filter((h) => !BARE_PAGE_HEADING.test(h.text.trim())).at(-1) ?? pages[0];
  if (page === undefined) return undefined;
  const after = outline.slice(outline.indexOf(page) + 1).filter((e) => e.kind === 'heading');
  return after.every((h) => pages.includes(h)) ? page : undefined;
}

/** The blocks under `heading`, up to the next heading. */
function sectionUnder(
  outline: readonly prose.OutlineEntry[],
  heading: prose.OutlineEntry,
): prose.OutlineEntry[] {
  const from = outline.indexOf(heading) + 1;
  const next = outline.findIndex((e, i) => i >= from && e.kind === 'heading');
  return outline.slice(from, next < 0 ? outline.length : next);
}

/** The number the next item under `heading` takes. */
function nextNumber(outline: readonly prose.OutlineEntry[], heading: prose.OutlineEntry): number {
  const items = outline.filter(
    (e) => e.underHeadingId === heading.id && e.ordered && (e.depth ?? 0) === 0,
  );
  return items.length + 1;
}

/** How many ticks a dictation stays open after its last counting cue. */
export const DICTATION_WINDOW = 3;

/** What one tick dictates, judged against the ticks before it. */
export interface DictationTick {
  /**
   * This tick's cues that count: a page or count cue always, an item cue only
   * while the speaker is dictating.
   */
  cues: DictationCue[];
  /**
   * How many ticks ago the last page or item cue that counted was spoken (1
   * is the tick just before this one). Absent when there was none within
   * `DICTATION_WINDOW`.
   */
  sinceCue?: number;
}

/**
 * The tick's dictation with no memory of earlier ticks: an item cue counts
 * only beside a page cue in the same tick. What a caller without a session
 * (a test, a one-off compose) gets.
 */
export function dictationTickOf(turns: readonly { text: string }[]): DictationTick {
  const all = dictationCues(turns);
  const opens = all.some((c) => c.kind === 'page');
  return { cues: all.filter((c) => c.kind !== 'item' || opens) };
}

/**
 * Per-meeting memory of the last dictation cue, so an ordering word counts as
 * an item only while a dictation is actually running. Call `see` once per
 * composed tick, in order.
 */
export function createDictationMemory(): {
  see(turns: readonly { text: string }[]): DictationTick;
} {
  let tick = 0;
  let lastCue: number | undefined;
  return {
    see(turns) {
      tick += 1;
      const ago = lastCue === undefined ? undefined : tick - lastCue;
      const recent = ago !== undefined && ago <= DICTATION_WINDOW ? ago : undefined;
      const all = dictationCues(turns);
      const dictating = recent !== undefined || all.some((c) => c.kind === 'page');
      const cues = all.filter((c) => c.kind !== 'item' || dictating);
      if (cues.some((c) => c.kind !== 'count')) lastCue = tick;
      return { cues, ...(recent !== undefined ? { sinceCue: recent } : {}) };
    },
  };
}

/**
 * The block that names what this tick's dictation asks for, or null when the
 * tick carries no cue that counts. A tick that only adds a detail gets no
 * block: `foldDetailsIntoItem` nests its dash note into the item instead.
 */
export function dictationDirective(
  outline: readonly prose.OutlineEntry[],
  tick: DictationTick,
): string | null {
  const wanted = tick.cues;
  if (wanted.length === 0) return null;
  const pages = pageHeadings(outline);
  const onPage = currentPage(outline);
  // The page this tick's items go on: the one it names, or the one it opens,
  // or the one the speaker is on.
  const opened = wanted.find((c) => c.kind === 'page')?.page;
  const lines = [
    "THIS SPEECH DICTATES THE SHAPE OF A DOCUMENT. Keep the speaker's shape:",
    'do not sort these lines into topics of your own, and do not drop one.',
  ];
  for (const cue of wanted) {
    if (cue.kind === 'count') {
      lines.push(
        `- "${cue.sentence}" counts the pages. Open no page heading yet: open each one ` +
          'when the speaker says what that page is.',
      );
      continue;
    }
    if (cue.kind === 'page') {
      const had = pages.find((h) => pageOf(h) === cue.page);
      lines.push(
        had
          ? `- "${cue.sentence}" names page ${cue.page}, and heading ${had.id} ("${had.text}") ` +
              'is already that page. Do not open a second heading for it. ' +
              (BARE_PAGE_HEADING.test(had.text.trim())
                ? `Name it in the speaker's words: {"op":"replace_block","blockId":"${had.id}",` +
                  `"markdown":"${'#'.repeat(had.level ?? 2)} ${had.text.trim().replace(/[.:]$/, '')}: <what the page is>"}.`
                : "Put the page's items under it.")
          : `- "${cue.sentence}" names a page. Open ONE heading for it in the speaker's ` +
              `words: "Page ${cue.page}: <what the page is>".`,
      );
      continue;
    }
    const named = cue.page ?? opened;
    const heading = named ? pages.find((h) => pageOf(h) === named) : onPage;
    lines.push(
      heading
        ? `- "${cue.sentence}" is the next item of page heading ${heading.id} ("${heading.text}"). ` +
            'Write it as ONE numbered note under that heading: ' +
            `{"op":"insert_under_heading","headingId":"${heading.id}","markdown":"${nextNumber(
              outline,
              heading,
            )}. <the item>"}. Numbered, not a dash bullet, and not a heading of its own.`
        : `- "${cue.sentence}" is the next item of a page. Write it as a numbered note ` +
            '("1. <the item>") under that page\'s heading.',
    );
  }
  lines.push('A detail or a reason about an item stays in that item, or as a sub-bullet under it.');
  return lines.join('\n');
}

const DASH_LINE = /^\s*[-*+]\s+(.+)$/;
/** A note that is its own kind of thing, never a detail of an item. */
const OWN_NOTE = /^\*\*[^*]+:\*\*|^(?:question|decision|action|ask)\s*:|\?\s*$/i;

/**
 * A detail spoken about the last item of a dictated page, moved INTO that
 * item as a sub-bullet rather than left as a dash note between two numbered
 * items.
 *
 * WHY THE SERVER DOES IT. The directive above asks for exactly this, and on
 * the synthetic dictation the model still answered a detail tick ("we repave
 * the high street before the harbour road, because…") with a top-level dash
 * note under the page heading. That one note closes the numbered list, so the next item
 * opens a second list and reads as "1." again: the order the speaker gave is
 * broken on the page even though every item is there. A dash note cannot be
 * nested under a numbered item afterwards either — `nest_blocks` never
 * gathers across lists of different kinds (`prose-nest.ts`).
 *
 * NARROW ON PURPOSE. Only on the ONE tick straight after a dictation cue
 * (`sinceCue === 1`) that carries no cue of its own, while the speaker is on a
 * dictated page, the last note under it is a top-level numbered item the
 * note-taker wrote, and the edit is a plain dash insert at the end of that
 * page. Two ticks on, a dash note is a note of its own, even with the page
 * still the last heading. Anything else is left exactly as composed.
 *
 * THE ITEM KEEPS ITS OWN MARKDOWN. The rewrite replaces the whole item, so
 * `itemMarkdown` (the item's first line as the doc serializes it) carries its
 * bold, links and code through. Without it the fold falls back to the
 * outline's plain text, and refuses an item whose text that outline truncated.
 */
export function foldDetailsIntoItem(
  edits: readonly prose.BlockEdit[],
  outline: readonly prose.OutlineEntry[],
  tick: DictationTick | undefined,
  authorId: string,
  itemMarkdown?: (blockId: string) => string | undefined,
): { edits: prose.BlockEdit[]; folded: number } {
  const unchanged = { edits: [...edits], folded: 0 };
  if (tick === undefined || tick.cues.length > 0 || tick.sinceCue !== 1) return unchanged;
  const last = currentPage(outline);
  if (last === undefined) return unchanged;
  const item = sectionUnder(outline, last).at(-1);
  const endsDoc = ![...outline].slice(outline.indexOf(last) + 1).some((e) => e.kind === 'heading');
  if (item === undefined || !item.ordered || (item.depth ?? 0) !== 0 || item.author !== authorId) {
    return unchanged;
  }
  const own = itemMarkdown?.(item.id)?.trim();
  if (own === undefined && item.text.endsWith('…')) return unchanged;
  const text = own ?? item.text;
  if (edits.some((e) => 'blockId' in e && e.blockId === item.id)) return unchanged;
  const details: string[] = [];
  const kept: prose.BlockEdit[] = [];
  for (const edit of edits) {
    const atPageEnd =
      (edit.op === 'insert_under_heading' && edit.headingId === last.id) ||
      (edit.op === 'insert_at_end' && endsDoc);
    const lines = atPageEnd ? edit.markdown.split('\n').filter((l) => l.trim()) : [];
    const dashes = lines.map((l) => DASH_LINE.exec(l)?.[1]);
    const plain = dashes.every((d) => d !== undefined && !OWN_NOTE.test(d.trim()));
    if (lines.length > 0 && plain && /^\S/.test(lines[0] ?? '')) {
      details.push(...(dashes as string[]));
    } else {
      kept.push(edit);
    }
  }
  if (details.length === 0) return unchanged;
  const markdown = [
    `${nextNumber(outline, last) - 1}. ${text}`,
    ...details.map((d) => `   - ${d}`),
  ];
  kept.push({ op: 'replace_block', blockId: item.id, markdown: markdown.join('\n') });
  return { edits: kept, folded: details.length };
}

/**
 * The first line of block `blockId` as the doc serializes it, marks and all:
 * for a list item, its own paragraph without the items nested under it.
 * What `foldDetailsIntoItem` rewrites an item with, so folding a detail in
 * does not strip the item's bold or links.
 */
export function itemFirstLine(ydoc: Y.Doc, blockId: string): string | undefined {
  const el = prose.findBlockById(prose.getProseFragment(ydoc), blockId);
  if (el === undefined) return undefined;
  const first = el.nodeName === 'listItem' ? el.toArray()[0] : el;
  if (!(first instanceof Y.XmlElement) || first.nodeName !== 'paragraph') return undefined;
  const line = prose.serializeBlockToMarkdown(first).trim();
  return line.length > 0 && !line.includes('\n') ? line : undefined;
}
