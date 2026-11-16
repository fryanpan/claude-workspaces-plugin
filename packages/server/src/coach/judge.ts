/**
 * The server's check on a moment the coach session raises.
 *
 * The session decides when to speak; this decides whether what it sent may
 * reach his page. QUIET BY DEFAULT: models asked when to coach step in far
 * too often (in MetaCLASS, arXiv 2602.02457, they stayed quiet in 4% of the
 * cases where quiet was right in 42%). So a moment must name one goal AND
 * quote words from it, and the quote is checked here against the goal's own
 * text. He writes each goal with its trigger in it ("If I spend more than an
 * hour on X, ask me Y"), so the words a moment can quote are the moment he
 * named. Anything else is refused, with the reason, so the session can see
 * why.
 */
import type { LearningGoal } from './goals-doc.ts';

export const OBSERVED_MAX_CHARS = 140;
export const LINE_MAX_CHARS = 220;
/** The fewest words a quote of a longer goal may have. */
const MIN_QUOTE_WORDS = 3;

/** A raised moment, as `POST /coach/moments` declares it. */
export interface CoachMomentBody {
  /** 1-based index into the goals. */
  goal: number;
  matched: string;
  observed: string;
  line: string;
}
/** What `checkMoment` sees of a sent moment: each field present or not, unchecked. */
export type SentMoment = { [K in keyof CoachMomentBody]?: unknown };

export interface CheckedMoment {
  goalIndex: number;
  matched: string;
  observed: string;
  line: string;
}

const clean = (s: string) =>
  s
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Lower case, apostrophes and punctuation dropped, single spaces. */
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Are `quote`'s words, in order, a run of the goal's words? */
export function quotesGoal(quote: string, goalText: string): boolean {
  const q = words(quote);
  const t = words(goalText);
  if (!q || !t) return false;
  const n = q.split(' ').length;
  if (n < Math.min(MIN_QUOTE_WORDS, t.split(' ').length)) return false;
  return ` ${t} `.includes(` ${q} `);
}

/** The moment as checked, or the reason it is refused. `goal` is 1-based. */
export function checkMoment(
  body: SentMoment | null,
  goals: readonly LearningGoal[],
): CheckedMoment | string {
  const { goal, matched, observed, line } = body ?? {};
  if (typeof goal !== 'number' || !Number.isInteger(goal) || goal < 1 || goal > goals.length) {
    return `goal is a number from 1 to ${goals.length}`;
  }
  if (typeof matched !== 'string' || typeof observed !== 'string' || typeof line !== 'string') {
    return 'matched, observed and line are text';
  }
  const target = goals[goal - 1];
  if (!target || !quotesGoal(matched, target.text)) {
    return `matched must copy at least ${MIN_QUOTE_WORDS} words in order from goal ${goal}’s own words: "${target?.text.split('\n').join(' ') ?? ''}"`;
  }
  const o = clean(observed);
  const l = clean(line);
  if (o.length < 8 || o.length > OBSERVED_MAX_CHARS) {
    return `observed is 8 to ${OBSERVED_MAX_CHARS} characters`;
  }
  if (l.length < 20 || l.length > LINE_MAX_CHARS || !l.endsWith('?')) {
    return `line is 20 to ${LINE_MAX_CHARS} characters and ends with a question`;
  }
  return { goalIndex: goal - 1, matched: clean(matched), observed: o, line: l };
}
