/**
 * What a caller may send as a done-when list, read into the inputs the verbs
 * take — split from `task-done-when.ts`, which re-exports all three names, so
 * the verbs file stays one contract about verdicts and this one stays about
 * the words a list write carries.
 */
import {
  DONE_WHEN_LINES_MAX,
  DONE_WHEN_TEXT_MAX,
  type DoneWhenLine,
} from '@claude-workspaces/core/done-when';
import { cryptoId } from './task-fields.ts';

/** What a caller may send as one line when it WRITES the list. `id` present
 *  keeps that line's verdict and proof; `id` absent mints a new line. */
export interface DoneWhenInput {
  id?: string;
  text: string;
  /** `'owner'` writes the line as needing a person; `null` clears that; absent
   *  keeps whatever a named line already had, so an edit of its words that
   *  does not mention it (the panel's) cannot drop it. */
  needs?: 'owner' | null;
}

/**
 * A caller's `doneWhen` payload → the inputs the verbs take, or the 400 it
 * earns.
 *
 * Accepts a bare string as well as `{ text }`, because a create that says
 * `doneWhen: ["a share link opens the list", …]` is the shape an agent writes
 * first and refusing it buys nothing. `undefined` passes through as
 * `undefined`, which is the difference between "no lines named" and "an empty
 * list", and only the second clears an existing one.
 */
export function parseDoneWhenInput(
  raw: unknown,
):
  | { ok: true; lines?: DoneWhenInput[] }
  | { ok: false; error: 'bad-lines' | 'too-many-lines'; message: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'bad-lines', message: 'doneWhen must be an array of lines' };
  }
  if (raw.length > DONE_WHEN_LINES_MAX) {
    return {
      ok: false,
      error: 'too-many-lines',
      message: `a task may carry at most ${DONE_WHEN_LINES_MAX} done-when lines`,
    };
  }
  const lines: DoneWhenInput[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const source = typeof entry === 'string' ? { text: entry } : (entry as DoneWhenInput | null);
    const text = typeof source?.text === 'string' ? source.text.trim() : '';
    if (text.length === 0) {
      return {
        ok: false,
        error: 'bad-lines',
        message: 'every done-when line needs words — say the outcome a reader can check',
      };
    }
    if (text.length > DONE_WHEN_TEXT_MAX) {
      return {
        ok: false,
        error: 'bad-lines',
        message: `a done-when line is at most ${DONE_WHEN_TEXT_MAX} characters`,
      };
    }
    const id = typeof source?.id === 'string' && source.id.trim() !== '' ? source.id : undefined;
    // One line per id. A sequence naming the same id twice would mint two
    // stored lines with one identity, and the verbs downstream disagree about
    // which of them they mean — a report reaches the first through a Map, an
    // owner's check reaches the first through `find`, and the panel draws two
    // siblings under one key. Send a line with no id to add one.
    if (id !== undefined && seen.has(id)) {
      return {
        ok: false,
        error: 'bad-lines',
        message: `"${text}" repeats a done-when line id — each line appears once, and a new line carries no id`,
      };
    }
    if (id !== undefined) seen.add(id);
    const rawNeeds = (source as { needs?: unknown } | null)?.needs;
    if (rawNeeds !== undefined && rawNeeds !== null && rawNeeds !== 'owner') {
      return {
        ok: false,
        error: 'bad-lines',
        message: `"${text}" has needs ${JSON.stringify(rawNeeds)} — the only value is 'owner', for a line only a person can judge (null clears it)`,
      };
    }
    lines.push({
      text,
      ...(id !== undefined ? { id } : {}),
      ...(rawNeeds !== undefined ? { needs: rawNeeds } : {}),
    });
  }
  return { ok: true, lines };
}

/**
 * Mint the stored lines a create or a list-write asks for.
 *
 * `previous` is what the row already holds, and an input naming one of its ids
 * keeps that line's verdict, proof and attribution: editing the WORDS of a
 * line is not a retraction of the proof behind it. A line the input does not
 * name is dropped, which is how the panel's × removes one — the list write is
 * the whole list, so a removal needs no verb of its own.
 */
export function buildDoneWhenLines(
  inputs: readonly DoneWhenInput[],
  previous: readonly DoneWhenLine[] | undefined,
): DoneWhenLine[] {
  const held = new Map((previous ?? []).map((l) => [l.id, l]));
  return inputs.map((input) => {
    const kept = input.id !== undefined ? held.get(input.id) : undefined;
    const { needs: had, ...line }: DoneWhenLine = kept
      ? { ...kept, text: input.text }
      : { id: cryptoId('d'), text: input.text };
    // Absent keeps what the line had; null is the only way to clear it.
    const needs = input.needs === undefined ? had : (input.needs ?? undefined);
    return needs !== undefined ? { ...line, needs } : line;
  });
}
