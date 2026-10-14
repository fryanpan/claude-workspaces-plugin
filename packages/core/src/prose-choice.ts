/**
 * A choice block: a fenced code block whose language is `choice` and whose
 * one line names the options and the current pick.
 *
 *     ```choice
 *     id=lead-riverbend options="yes,maybe,no" picked="maybe"
 *     ```
 *
 * The editor draws it as a row of buttons, and a tap rewrites `picked` in the
 * block's text. The block is stored as an ordinary `codeBlock`, so the parser
 * and the serializer treat it as they treat any other fence: the file comes
 * back byte for byte, every open page sees a pick through the same Yjs text
 * edit any typing makes, and `get_doc` returns the pick in the markdown.
 *
 * Values are bare (`picked=maybe`) or double-quoted (`picked="not sure"`).
 * Options are comma-separated. A block with no option reads as no choice,
 * and the editor shows its source instead.
 */

/** The `codeBlock` language a choice block is stored under. */
export const CHOICE_LANGUAGE = 'choice';

export interface ChoiceBlock {
  /** The agent's name for this block, when it gave one. */
  id?: string;
  options: string[];
  /** The option picked, or undefined when nothing is. */
  picked?: string;
}

interface Field {
  key: string;
  value: string;
  start: number;
  end: number;
}

const FIELD = /([A-Za-z][\w-]*)=(?:"([^"]*)"|(\S*))/g;

function fieldsOf(text: string): Field[] {
  const out: Field[] = [];
  for (const m of text.matchAll(FIELD)) {
    const start = m.index ?? 0;
    out.push({
      key: m[1] ?? '',
      value: m[2] ?? m[3] ?? '',
      start,
      end: start + m[0].length,
    });
  }
  return out;
}

/** Read a choice block's text. Null when it names no option. */
export function parseChoice(text: string): ChoiceBlock | null {
  const fields = fieldsOf(text);
  const get = (key: string) => fields.find((f) => f.key === key)?.value;
  const options = (get('options') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  if (options.length === 0) return null;
  const id = get('id');
  const picked = get('picked');
  return {
    ...(id ? { id } : {}),
    options,
    ...(picked && options.includes(picked) ? { picked } : {}),
  };
}

function quote(value: string): string {
  return /^[^\s"]+$/.test(value) ? value : `"${value}"`;
}

/**
 * The block's text with `picked` set to `option`, or removed when `option` is
 * null. Every other byte of the line is kept, so a pick is the smallest text
 * edit that says it.
 */
export function setChoicePick(text: string, option: string | null): string {
  const field = fieldsOf(text).find((f) => f.key === 'picked');
  if (option === null) {
    if (!field) return text;
    // Take the one space before the field with it, so set-then-clear is a no-op.
    const from = field.start > 0 && text[field.start - 1] === ' ' ? field.start - 1 : field.start;
    return text.slice(0, from) + text.slice(field.end);
  }
  const written = `picked=${quote(option)}`;
  if (field) return text.slice(0, field.start) + written + text.slice(field.end);
  const line = text.replace(/\s+$/, '');
  return `${line}${line.length > 0 ? ' ' : ''}${written}${text.slice(line.length)}`;
}
