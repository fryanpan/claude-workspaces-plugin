/**
 * Reading a model's reply as a list of block edits.
 *
 * STRICT, TOTAL, AND LOUD ABOUT WHAT IT THREW AWAY. The old contract took the
 * reply as prose: anything the model said was notes, and a malformed answer
 * merely produced strange notes. This one takes it as a command list against
 * block ids, where a malformed entry would either do nothing or — worse — do
 * something to the wrong block. So every entry is checked against the shape
 * `applyBlockEdits` accepts, an entry that fails is DISCARDED with a reason,
 * and the reasons come back to the caller. A reply that parses to nothing is
 * the tick's error, which is how it reaches the carry-forward and the log
 * instead of the doc.
 *
 * It never throws, for the same reason `sanitizeNotesReply` never did: the
 * caller is a tick in a live meeting, and a parser that can reject by
 * exception is a parser that can lose a meeting's notes to a stray comma.
 */

import type { prose } from '@claude-workspaces/core';

export interface ParsedNotesEdits {
  /** The entries that were well formed, in the order the model wrote them. */
  edits: prose.BlockEdit[];
  /** One line per entry discarded, saying which and why. Empty is the healthy
   *  state; anything here is worth a log line even when `edits` is non-empty,
   *  because a dropped edit is a point the notes are missing. */
  dropped: string[];
}

/** Strip a markdown code fence, if the model wrapped its JSON in one. Models
 *  wrap JSON in markdown about as often as they wrap markdown in markdown. */
function stripFence(raw: string): string {
  const text = raw.trim();
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  return fenced?.[1] !== undefined ? fenced[1].trim() : text;
}

/** The JSON value spanning the first `open` to the last `close` in `text`,
 *  or `undefined` when there is no such span or it does not parse. */
function sliceParse(text: string, open: string, close: string): unknown {
  const start = text.indexOf(open);
  if (start < 0) return undefined;
  const end = text.lastIndexOf(close);
  if (end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The JSON array or object in `text`, as a value — or `undefined`.
 *
 * Sliced to the outermost brackets before parsing, so a sentence of preamble
 * ("Here are the edits:") costs the tick nothing. A reply with no bracket at
 * all is not JSON and is reported as such.
 *
 * BOTH SHAPES ARE TRIED, not whichever bracket came first. Taking the
 * earlier of `[` and `{` lost a whole tick to a stray brace in the preamble:
 * "Here's what I'd note {roughly}: [ … ]" picked the `{`, and `lastIndexOf`
 * for its `}` landed before the array had even opened, so the reply parsed
 * to nothing and every turn in it was carried forward. Whichever slice
 * yields an edit list wins; the array is preferred because that is the shape
 * the prompt asks for.
 */
function parseJsonish(text: string): unknown {
  const trimmed = stripFence(text);
  const asArray = sliceParse(trimmed, '[', ']');
  if (Array.isArray(asArray)) return asArray;
  const asObject = sliceParse(trimmed, '{', '}');
  if (asObject !== undefined) return asObject;
  return asArray;
}

/** A non-empty string, or nothing. Block ids and markdown are both this. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Turn one entry into an edit, or say why it is not one. */
function readEdit(entry: unknown, at: number): { edit: prose.BlockEdit } | { why: string } {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { why: `edit ${at}: not an object` };
  }
  const raw = entry as Record<string, unknown>;
  const op = raw.op;
  // `markdown` is trimmed of trailing space only: leading space is a nested
  // bullet's indentation, and eating it would flatten a sub-point into the
  // list above it.
  const markdown = str(raw.markdown)?.replace(/\s+$/, '');
  switch (op) {
    case 'insert_at_end': {
      if (markdown === undefined) return { why: `edit ${at}: insert_at_end without markdown` };
      return { edit: { op, markdown } };
    }
    case 'insert_under_heading': {
      const headingId = str(raw.headingId);
      if (headingId === undefined) return { why: `edit ${at}: insert_under_heading without id` };
      if (markdown === undefined) {
        return { why: `edit ${at}: insert_under_heading without markdown` };
      }
      return { edit: { op, headingId, markdown } };
    }
    case 'replace_block': {
      const blockId = str(raw.blockId);
      if (blockId === undefined) return { why: `edit ${at}: replace_block without id` };
      if (markdown === undefined) return { why: `edit ${at}: replace_block without markdown` };
      return { edit: { op, blockId, markdown } };
    }
    case 'delete_block': {
      const blockId = str(raw.blockId);
      if (blockId === undefined) return { why: `edit ${at}: delete_block without id` };
      return { edit: { op, blockId } };
    }
    case 'nest_blocks': {
      const leadBlockId = str(raw.leadBlockId);
      if (leadBlockId === undefined) return { why: `edit ${at}: nest_blocks without a lead id` };
      // Every id must be a string, and the lead must not be among them: a
      // list that names its own lead would move a bullet under itself. Both
      // refuse the WHOLE edit rather than being filtered out of it — this
      // parser is all-or-nothing everywhere else, and quietly moving three of
      // the four bullets a model named is a regroup nobody asked for, done
      // with no line in `dropped` to say it happened.
      const raws = Array.isArray(raw.blockIds) ? raw.blockIds : undefined;
      if (raws === undefined) return { why: `edit ${at}: nest_blocks without blockIds` };
      const blockIds: string[] = [];
      for (const entry of raws) {
        const id = str(entry);
        if (id === undefined)
          return { why: `edit ${at}: nest_blocks with a blockId that is not text` };
        if (id === leadBlockId) return { why: `edit ${at}: nest_blocks naming its own lead ${id}` };
        blockIds.push(id);
      }
      if (blockIds.length === 0) return { why: `edit ${at}: nest_blocks with no blocks to move` };
      return { edit: { op, leadBlockId, blockIds } };
    }
    default:
      return { why: `edit ${at}: unknown op ${JSON.stringify(op)}` };
  }
}

/**
 * Read a model's reply as block edits.
 *
 * Accepts a bare array, or an object with an `edits` array — models offer both
 * and neither is wrong enough to lose a tick over. Anything else, and the
 * whole reply is one `dropped` line naming what arrived instead.
 */
export function parseNotesEdits(raw: string): ParsedNotesEdits {
  const value = parseJsonish(raw);
  if (value === undefined) return { edits: [], dropped: ['reply was not JSON'] };
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as { edits?: unknown }).edits)
      ? ((value as { edits: unknown[] }).edits as unknown[])
      : undefined;
  if (list === undefined) return { edits: [], dropped: ['reply held no array of edits'] };

  const edits: prose.BlockEdit[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const read = readEdit(list[i], i);
    if ('edit' in read) edits.push(read.edit);
    else dropped.push(read.why);
  }
  return { edits, dropped };
}
