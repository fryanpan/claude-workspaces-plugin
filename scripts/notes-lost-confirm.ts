/**
 * A second look at each idea the lost-idea judge called lost, which only
 * counts if the judge can point at the note.
 *
 * WHY. `judgeCarried` reads up to 40 ideas against the whole notes in one
 * call, and on a long meeting the notes run to 700 lines. Read by hand, a
 * third of one meeting's "lost" ideas were carried by a note the judge had
 * not found — usually a paraphrase, or a name the transcript spelled two
 * ways. That error moves the rate by several points from run to run, which
 * is larger than most changes to the note-taker could be measured against.
 *
 * WHAT MAKES IT A CHECK AND NOT A SECOND OPINION. The judge is asked to COPY
 * the line that carries the idea. The idea counts as carried only when that
 * copy is really in one line of the notes and is long enough to say
 * something. A judge that wants to say "carried" without a line to show
 * cannot. It can still quote a line that is about the topic and does not
 * carry the idea; the hand labels in the task's report measure how often.
 *
 * The scorer reports the rate before and after, so a reader can see what
 * this pass changed.
 */

import type { SummaryCredential } from '../packages/server/src/summarize.ts';
import { type ToolSpec, callTool } from './notes-eval-ideas.ts';

/** The fewest words a quote needs to carry an idea. */
const MIN_QUOTE_WORDS = 3;

const SPEAKER_TAG = /\[@([^\]]+)\]\(speaker:[^)]*\)/g;

function norm(text: string): string {
  return text
    .replace(SPEAKER_TAG, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6})\s+/, '')
    .replace(/[*_`]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Is `quote` copied from one line of `notes`, and long enough to say
 *  something? */
export function quoteCarries(quote: string, notes: string): boolean {
  const q = norm(quote);
  if (q.split(' ').filter(Boolean).length <= MIN_QUOTE_WORDS - 1) return false;
  return notes.split('\n').some((line) => norm(line).includes(q));
}

/** One quote per idea, in idea order, `''` for none; null when the reply
 *  skipped, repeated or mis-typed an idea. */
export function parseQuotes(input: unknown, count: number): string[] | null {
  const rows = (input as { quotes?: unknown } | null)?.quotes;
  if (!Array.isArray(rows)) return null;
  const out = new Array<string | null>(count).fill(null);
  for (const row of rows as Array<{ n?: unknown; quote?: unknown }>) {
    const i = typeof row?.n === 'number' ? row.n - 1 : -1;
    if (i < 0 || i >= count || out[i] !== null || typeof row.quote !== 'string') return null;
    out[i] = row.quote;
  }
  return out.every((q) => q !== null) ? (out as string[]) : null;
}

const CONFIRM_SYSTEM = [
  'You are checking meeting notes for ideas a first reader said were missing.',
  '',
  'For each numbered idea, find the ONE line of the notes that says this',
  'particular thing, in any words, however short. Copy that line exactly as',
  'the notes write it. If no line says it, give an empty quote.',
  '',
  'A line about the same topic that does not say this particular thing does',
  'not count. A line that gets the specifics wrong (who, which thing, the',
  'number, done or not done) does not count. A name spelled differently is',
  'the same name when the rest of the line fits.',
  '',
  'Answer with the record_quotes tool: one entry per idea, in order.',
].join('\n');

const CONFIRM_TOOL: ToolSpec = {
  name: 'record_quotes',
  description: 'Give, per idea, the line of the notes that carries it, or an empty quote.',
  input_schema: {
    type: 'object' as const,
    properties: {
      quotes: {
        type: 'array',
        items: {
          type: 'object',
          properties: { n: { type: 'number' }, quote: { type: 'string' } },
          required: ['n', 'quote'],
        },
      },
    },
    required: ['quotes'],
  },
};

/**
 * Which of these lost ideas a quoted line shows to be carried after all.
 * Null when the reply could not be read twice; the caller then keeps the
 * first verdict.
 */
export async function confirmLost(
  key: SummaryCredential,
  ideas: readonly string[],
  notes: string,
): Promise<boolean[] | null> {
  if (ideas.length === 0) return [];
  const head = `The notes:\n${notes || '(the notes are empty)'}`;
  const user = `The ideas:\n${ideas.map((idea, i) => `${i + 1}. ${idea}`).join('\n')}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await callTool(
      key,
      CONFIRM_SYSTEM,
      user,
      CONFIRM_TOOL,
      300 + ideas.length * 80,
      head,
    );
    const quotes = parseQuotes(out, ideas.length);
    if (quotes) return quotes.map((q) => quoteCarries(q, notes));
  }
  return null;
}
