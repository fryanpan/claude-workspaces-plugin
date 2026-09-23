/**
 * Two decidable readings of a dictation's notes: did the layout the speaker
 * dictated survive as that layout, and did each reason stay with its claim.
 *
 * DECIDED IN CODE, NOT BY A JUDGE, because both are questions about where
 * words sit. "Is item two below item one, under the page's heading, in a
 * numbered list" and "is the reason in the same bullet as the claim" have
 * answers a regex can reach, and `notes-eval.ts`'s rule is that a model
 * grading what code can settle is money spent on a worse answer.
 *
 * MATCHING IS BY THE SPEAKER'S CONTENT WORDS, stemmed through the same
 * lexicon every other notes check reads (`contentWords`). A line carries a
 * set of words when it holds at least two thirds of them, so a paraphrase
 * that keeps the nouns passes and a line about something else does not.
 */
import { contentWords } from '../packages/server/src/notes-idea-coverage.ts';
import { allBullets } from '../packages/server/src/notes-quality.ts';
import type { BecauseIdea, DictatedPage } from './notes-fidelity-dictation.ts';

/** Whether `line` carries enough of `keys` to be about them. */
export function carries(line: string, keys: readonly string[]): boolean {
  const have = new Set(contentWords(line));
  const want = [...new Set(keys.flatMap((k) => contentWords(k)))];
  if (want.length === 0) return false;
  const hit = want.filter((w) => have.has(w)).length;
  return hit >= Math.ceil((want.length * 2) / 3);
}

/** One page's reading. */
export interface PageReading {
  heading: string | null;
  /** Line index, inside the page's section, of each item; -1 when absent. */
  at: number[];
  /** Whether every item found sits on a numbered list line. */
  numbered: boolean;
  /** Heading found, every item found, in the dictated order, numbered. */
  ok: boolean;
  why: string;
}

interface Section {
  heading: string;
  lines: string[];
}

function sectionsOf(markdown: string): Section[] {
  const out: Section[] = [];
  let current: Section | null = null;
  for (const raw of markdown.split('\n')) {
    const head = raw.trim().match(/^#{1,6}\s+(.*)$/);
    if (head) {
      current = { heading: head[1]!.trim(), lines: [] };
      out.push(current);
      continue;
    }
    if (current && raw.trim()) current.lines.push(raw);
  }
  return out;
}

const NUMBERED = /^\s*\d+[.)]\s+/;
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** How one dictated page came out. */
export function readPage(markdown: string, page: DictatedPage): PageReading {
  const section = sectionsOf(markdown).find((s) => carries(s.heading, page.heading));
  if (!section) {
    return { heading: null, at: [], numbered: false, ok: false, why: 'no heading names the page' };
  }
  const at = page.items.map((item) =>
    section.lines.findIndex((line) => LIST_LINE.test(line) && carries(line, item)),
  );
  const missing = at.filter((i) => i < 0).length;
  const found = at.filter((i) => i >= 0);
  const inOrder = found.every((v, i) => i === 0 || v > (found[i - 1] as number));
  const numbered = found.length > 0 && found.every((i) => NUMBERED.test(section.lines[i] ?? ''));
  // ONE list: a top-level line that is not a numbered item, sitting between
  // two items, closes the list, and the next item reads as "1." again.
  const first = Math.min(...found);
  const lastAt = Math.max(...found);
  const unbroken = section.lines
    .slice(first, lastAt + 1)
    .every((line) => /^\s/.test(line) || NUMBERED.test(line));
  const why =
    missing > 0
      ? `${missing} of ${page.items.length} items not under the heading`
      : !inOrder
        ? 'items out of the dictated order'
        : !numbered
          ? 'items are not a numbered list'
          : !unbroken
            ? 'a note between two items breaks the numbered list'
            : 'kept';
  return { heading: section.heading, at, numbered, ok: why === 'kept', why };
}

/** Every page, and the share that kept its dictated layout. */
export function pageOrderScore(
  markdown: string,
  pages: readonly DictatedPage[],
): { pages: PageReading[]; kept: number; share: number } {
  const readings = pages.map((p) => readPage(markdown, p));
  const kept = readings.filter((r) => r.ok).length;
  return { pages: readings, kept, share: pages.length === 0 ? 1 : kept / pages.length };
}

/** One "because" claim's reading. */
export interface CauseReading {
  idea: BecauseIdea;
  /** The bullet that carries claim and reason together, when one does. */
  bullet: string | null;
  /** Whether any bullet carries the claim at all. */
  claimed: boolean;
}

/**
 * Cause retention, per idea: a claim spoken with a "because" is retained when
 * ONE bullet carries both the claim and its reason. A reason written as its
 * own bullet, nested or not, is not retained — the reader of that bullet
 * cannot tell which claim it answers, which is the failure being measured.
 */
export function causeRetention(
  markdown: string,
  ideas: readonly BecauseIdea[],
): { ideas: CauseReading[]; retained: number; share: number } {
  const bullets = allBullets(markdown);
  const readings = ideas.map((idea) => {
    const claimed = bullets.filter((b) => carries(b, idea.claim));
    const both = claimed.find((b) => carries(b, idea.reason)) ?? null;
    return { idea, bullet: both, claimed: claimed.length > 0 };
  });
  const retained = readings.filter((r) => r.bullet !== null).length;
  return { ideas: readings, retained, share: ideas.length === 0 ? 1 : retained / ideas.length };
}
