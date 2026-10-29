/**
 * A note says what was said, never that something has not been said yet.
 *
 * WHY THIS EXISTS. Replayed over four recorded meetings, about one note in
 * eight ended by saying its point was unfinished: "...; not finished yet",
 * "(unfinished)", "Speaker has not finished." The note-taker had been handed
 * a slice of a sentence still being spoken, flagged as unfinished, and wrote
 * the flag into the note. Nothing ever came back to take it out once the
 * rest of the sentence arrived, so the reader was left a minutes full of
 * half-thoughts announcing themselves.
 *
 * The ceiling now cuts at sentence ends (`pause-ticker.ts`) and the prompt
 * says not to write one, so this is the backstop for what still gets
 * through: a trailing clause, sentence or parenthesis that only reports the
 * speech as unfinished is taken off the note. The rest of the note stays as
 * written. A note that is nothing BUT such a report is dropped, because it
 * carries no point to keep.
 */

import type { prose } from '@claude-workspaces/core';

/** Words that say a point is not finished yet. */
const PENDING =
  /\b(?:unfinished|not (?:yet )?finished|incomplete|cut off|still being (?:made|said|described)|(?:has|have|had) not finished|mid-(?:sentence|thought)|not yet (?:clear|made|said|in the transcript)|still speaking|still talking)\b/i;

/** Words that say it is the SPEECH that is unfinished, not the thing it was
 *  about: "the survey is incomplete" is a point, "her point is unfinished"
 *  is not. */
const ABOUT_SPEECH =
  /\b(?:point|sentence|thought|speaker|said|saying|speaking|talking|yet|transcript)\b/i;

/** Whether a clause is a report on the speech rather than part of the note. */
function reportsPending(clause: string): boolean {
  if (!PENDING.test(clause)) return false;
  const words = clause.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return ABOUT_SPEECH.test(clause) || /^\s*\(/.test(clause) || words <= 3;
}

/** The last clause of a note: a parenthesis, a `;` or dash clause, a whole
 *  last sentence, or a `, but …` tail. */
const TAIL =
  /(\s*\([^()]*\)|\s*[;—–]\s*[^;—–]*|(?<=[.!?])\s+[^.!?]+[.!?]?|,\s+(?:but|though|and)\s+[^,]*)\s*\.?\s*$/;

/** The longest tail read as a report on the speech rather than part of it. */
const MAX_TAIL_WORDS = 12;

/** The words of a note a reader reads: no marker, no speaker tag, no link. */
function readWords(line: string): string[] {
  const bare = line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\[@[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
  return bare === '' ? [] : bare.split(/\s+/);
}

/**
 * One note line without its trailing "not finished" report, or `null` when
 * the line was nothing else.
 */
export function withoutPendingClause(line: string): string | null {
  let out = line;
  for (let i = 0; i < 3; i++) {
    const m = out.match(TAIL);
    if (!m || m.index === undefined) break;
    const tail = m[0];
    if (!reportsPending(tail) || tail.trim().split(/\s+/).length > MAX_TAIL_WORDS) break;
    out = out.slice(0, m.index).replace(/[\s,;:—–-]+$/, '');
  }
  const words = readWords(out);
  // Nothing left, or a short line that is itself only the report.
  if (words.length === 0 || (words.length <= 6 && PENDING.test(out) && ABOUT_SPEECH.test(out))) {
    return null;
  }
  if (out !== line && /[.!?]\s*$/.test(line) && !/[.!?]$/.test(out)) out += '.';
  return out;
}

/** A bullet or numbered note at any depth. */
const NOTE_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

/** The batch with every note's pending clause taken off. Headings and other
 *  lines are left alone; an edit this pass left with no words is dropped. */
export function stripPendingClauses(edits: readonly prose.BlockEdit[]): {
  edits: prose.BlockEdit[];
  stripped: number;
} {
  let stripped = 0;
  const out: prose.BlockEdit[] = [];
  for (const edit of edits) {
    if (!('markdown' in edit)) {
      out.push(edit);
      continue;
    }
    const lines: string[] = [];
    let here = 0;
    for (const line of edit.markdown.split('\n')) {
      if (!NOTE_LINE.test(line)) {
        lines.push(line);
        continue;
      }
      const kept = withoutPendingClause(line);
      if (kept !== line) here++;
      if (kept !== null) lines.push(kept);
    }
    // An edit this pass did not touch goes through byte for byte, a wordless
    // one included: refusing that is the guard's job, under its own name.
    if (here === 0) {
      out.push(edit);
      continue;
    }
    stripped += here;
    const markdown = lines.join('\n');
    if (!/[\p{L}\p{N}]/u.test(markdown)) continue;
    out.push({ ...edit, markdown });
  }
  return { edits: out, stripped };
}
