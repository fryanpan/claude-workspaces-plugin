/**
 * A doc's metadata: the YAML front matter at the top of its `.md`, with the
 * fields a schema declares. The contract other repos read is
 * docs/architecture/doc-metadata.md; this module is its one implementation,
 * shared by the server (the read and set verbs) and the editor (the form).
 *
 * The front matter is stored in the live doc as the first block, a
 * `codeBlock` whose language is `yaml-frontmatter` holding the YAML lines
 * between the two `---` (core `prose-markdown.ts`). So an edit here is an edit
 * to that block's text: it reaches every open page through Yjs and the file
 * through the normal write-back.
 *
 * Two rules keep the file stable:
 * - Reading never writes. Values that break the schema are reported, and the
 *   file keeps its bytes until somebody sets a field.
 * - Setting a field rewrites only that field's lines. Comments, key order,
 *   keys the schema does not name, and other fields' spelling stay as they
 *   were.
 *
 * Only a subset of YAML is read: top-level `key: value` lines whose value is
 * a plain or quoted scalar, a flow list (`[a, b]`) or a block list (`- a`).
 * Anything else under a key (a nested map, a `|` block) is kept byte for byte
 * and reported as a value this editor cannot read.
 */

import {
  type MetadataField,
  type MetadataSchema,
  type MetadataValue,
} from './doc-metadata-schema.ts';

export * from './doc-metadata-schema.ts';

// ---------------------------------------------------------------------------
// Reading the YAML

/** One value as written. `unreadable` is YAML outside the subset. */
export type RawValue =
  | { kind: 'empty' }
  | { kind: 'scalar'; text: string; quoted: boolean }
  | { kind: 'list'; items: string[]; block: boolean }
  | { kind: 'unreadable' };

/** A top-level key and the lines [start, end) it occupies. */
export interface FrontMatterEntry {
  key: string;
  start: number;
  end: number;
  value: RawValue;
}

const ENTRY_RE = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const ITEM_RE = /^([ \t]*)-(?:[ \t]+(.*?))?[ \t]*$/;

/** A quoted scalar at the start of `s`: its text and the rest of `s`. */
function readQuoted(s: string): { text: string; rest: string } | null {
  if (s.startsWith("'")) {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return { text: out, rest: s.slice(i + 1) };
      }
      out += s[i];
    }
    return null;
  }
  if (s.startsWith('"')) {
    for (let i = 1; i < s.length; i++) {
      if (s[i] === '\\') {
        i++;
        continue;
      }
      if (s[i] === '"') {
        try {
          const text = JSON.parse(s.slice(0, i + 1)) as string;
          return { text, rest: s.slice(i + 1) };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** A trailing comment is ` #…`; nothing else follows a quoted scalar. */
function onlyComment(rest: string): boolean {
  const t = rest.trim();
  return t === '' || t.startsWith('#');
}

function stripPlainComment(s: string): string {
  const at = s.search(/[ \t]#/);
  return (at === -1 ? s : s.slice(0, at)).trim();
}

/** One scalar in value position, or null when it is outside the subset. */
function readScalar(s: string): { text: string; quoted: boolean } | null {
  const q = readQuoted(s);
  if (q) return onlyComment(q.rest) ? { text: q.text, quoted: true } : null;
  if (/^['"]/.test(s)) return null;
  const text = stripPlainComment(s);
  // Block scalars, anchors, aliases, tags and maps are outside the subset.
  if (/^[|>&*!{]/.test(text)) return null;
  if (text.startsWith('[')) return null;
  return { text, quoted: false };
}

function readFlowList(s: string): string[] | null {
  const body = stripPlainComment(s);
  if (!body.startsWith('[') || !body.endsWith(']')) return null;
  const inner = body.slice(1, -1).trim();
  if (inner === '') return [];
  const items: string[] = [];
  let i = 0;
  while (i <= inner.length) {
    while (inner[i] === ' ' || inner[i] === '\t') i++;
    const rest = inner.slice(i);
    let text: string;
    let next: number;
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const q = readQuoted(rest);
      if (!q) return null;
      text = q.text;
      next = i + (rest.length - q.rest.length);
      while (inner[next] === ' ' || inner[next] === '\t') next++;
    } else {
      const comma = rest.indexOf(',');
      const raw = comma === -1 ? rest : rest.slice(0, comma);
      if (/[[\]{}]/.test(raw)) return null;
      text = raw.trim();
      next = i + raw.length;
    }
    items.push(text);
    if (next >= inner.length) break;
    if (inner[next] !== ',') return null;
    i = next + 1;
  }
  return items;
}

/** The top-level entries of a front matter's YAML, in file order. */
export function readFrontMatterEntries(yaml: string): FrontMatterEntry[] {
  const lines = yaml.split('\n');
  const out: FrontMatterEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const m = ENTRY_RE.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1] ?? '';
    const inline = m[2] ?? '';
    const start = i;
    i++;
    // The lines that belong to this key: indented ones, and `- ` items
    // (YAML lets a block list sit at the key's own column).
    const body: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (next.trim() === '') break;
      if (/^[ \t]/.test(next) || ITEM_RE.test(next)) {
        body.push(next);
        i++;
        continue;
      }
      break;
    }
    let value: RawValue;
    if (inline !== '' && !inline.startsWith('#')) {
      if (body.length > 0) value = { kind: 'unreadable' };
      else if (inline.startsWith('[')) {
        const items = readFlowList(inline);
        value = items ? { kind: 'list', items, block: false } : { kind: 'unreadable' };
      } else {
        const s = readScalar(inline);
        value = s ? { kind: 'scalar', ...s } : { kind: 'unreadable' };
      }
    } else if (body.length === 0) {
      value = { kind: 'empty' };
    } else {
      const items: string[] = [];
      let ok = true;
      for (const b of body) {
        const im = ITEM_RE.exec(b);
        const s = im ? readScalar(im[2] ?? '') : null;
        if (!s) {
          ok = false;
          break;
        }
        items.push(s.text);
      }
      value = ok ? { kind: 'list', items, block: true } : { kind: 'unreadable' };
    }
    out.push({ key, start, end: i, value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Judging values against the schema

export interface MetadataReading {
  /** Each schema field that has a value the schema accepts. */
  values: Record<string, MetadataValue>;
  /** Each schema field that is wrong, and what is wrong with it. */
  errors: Record<string, string>;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `s` is a real calendar date written YYYY-MM-DD. */
export function isIsoDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1;
}

/** What a plain YAML scalar is read as by a YAML library. */
function plainKind(text: string): 'null' | 'boolean' | 'number' | 'string' {
  if (text === '' || text === '~' || text === 'null' || text === 'Null' || text === 'NULL') {
    return 'null';
  }
  if (/^(true|false|True|False|TRUE|FALSE)$/.test(text)) return 'boolean';
  if (/^[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?$/.test(text) || /^0x[0-9a-fA-F]+$/.test(text)) {
    return 'number';
  }
  return 'string';
}

/** Longest text one field may hold, and most items one list may: a field,
 *  not a document. */
export const MAX_VALUE_CHARS = 2000;
export const MAX_LIST_ITEMS = 100;

/** A value the caller has in hand, judged against one field. */
export function checkValue(field: MetadataField, value: MetadataValue): string | null {
  if (typeof value === 'string' && value.length > MAX_VALUE_CHARS) {
    return `must be at most ${MAX_VALUE_CHARS} characters`;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_LIST_ITEMS) return `must hold at most ${MAX_LIST_ITEMS} items`;
    if (value.some((v) => typeof v === 'string' && v.length > MAX_VALUE_CHARS)) {
      return `each item must be at most ${MAX_VALUE_CHARS} characters`;
    }
  }
  switch (field.type) {
    case 'string': {
      if (typeof value !== 'string') return 'must be text';
      if (field.format === 'date' && value !== '' && !isIsoDate(value)) {
        return 'must be a date (YYYY-MM-DD)';
      }
      if (field.enum && value !== '' && !field.enum.includes(value)) {
        return `must be one of ${field.enum.join(', ')}`;
      }
      return null;
    }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'string[]':
      return Array.isArray(value) && value.every((v) => typeof v === 'string')
        ? null
        : 'must be a list of text';
  }
}

function valueOf(field: MetadataField, raw: RawValue): { value?: MetadataValue; error?: string } {
  if (raw.kind === 'empty') return {};
  if (raw.kind === 'unreadable') return { error: 'cannot be read here; edit it in the file' };
  if (field.type === 'string[]') {
    if (raw.kind !== 'list') return { error: 'must be a list' };
    return { value: raw.items };
  }
  if (raw.kind === 'list') return { error: 'must be a single value, not a list' };
  const kind = raw.quoted ? 'string' : plainKind(raw.text);
  if (kind === 'null') return {};
  let value: MetadataValue;
  if (field.type === 'number') {
    if (kind !== 'number') return { error: 'must be a number' };
    value = Number(raw.text.replace(/_/g, ''));
  } else if (field.type === 'boolean') {
    if (kind !== 'boolean') return { error: 'must be true or false' };
    value = raw.text.toLowerCase() === 'true';
  } else {
    // A date is written plain; any other text that a YAML library would read
    // as a number or a boolean is the wrong type for a text field.
    if (kind !== 'string' && field.format !== 'date') return { error: 'must be text' };
    value = raw.text;
  }
  const err = checkValue(field, value);
  return err ? { error: err } : { value };
}

/** Read a front matter's YAML (null: the doc has none) against a schema. */
export function readMetadata(schema: MetadataSchema, yaml: string | null): MetadataReading {
  const entries = new Map<string, FrontMatterEntry>();
  for (const e of yaml === null ? [] : readFrontMatterEntries(yaml)) {
    if (!entries.has(e.key)) entries.set(e.key, e);
  }
  const values: Record<string, MetadataValue> = {};
  const errors: Record<string, string> = {};
  for (const field of schema.fields) {
    const e = entries.get(field.key);
    const got = e ? valueOf(field, e.value) : {};
    if (got.error) {
      errors[field.key] = got.error;
      continue;
    }
    const v = got.value;
    const blank = v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
    if (v !== undefined) values[field.key] = v;
    if (blank && field.required) errors[field.key] = 'is required';
  }
  return { values, errors };
}

// ---------------------------------------------------------------------------
// Writing the YAML

/** A string as a YAML scalar: plain where a YAML library reads it back as
 *  the same text, double-quoted otherwise. `inFlow` also quotes `,[]{}`. */
function yamlString(s: string, inFlow: boolean, plainDate: boolean): string {
  if (plainDate && isIsoDate(s)) return s;
  const plainSafe =
    s !== '' &&
    s.trim() === s &&
    plainKind(s) === 'string' &&
    !isIsoDate(s) &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) &&
    !/: |:$| #|[\n\r\t]/.test(s) &&
    !(inFlow && /[,[\]{}]/.test(s));
  return plainSafe ? s : JSON.stringify(s);
}

/** The lines one field is written as, its key included. */
function fieldLines(
  field: MetadataField,
  value: MetadataValue,
  prev: FrontMatterEntry | undefined,
  prevLines: string[],
): string[] {
  const k = field.key;
  if (Array.isArray(value)) {
    if (prev?.value.kind === 'list' && prev.value.block && value.length > 0) {
      const first = prevLines[prev.start + 1] ?? '  - ';
      const indent = ITEM_RE.exec(first)?.[1] ?? '  ';
      return [`${k}:`, ...value.map((v) => `${indent}- ${yamlString(v, false, false)}`)];
    }
    return [`${k}: [${value.map((v) => yamlString(v, true, false)).join(', ')}]`];
  }
  if (typeof value === 'string')
    return [`${k}: ${yamlString(value, false, field.format === 'date')}`];
  return [`${k}: ${String(value)}`];
}

/** A value that clears its field: the key's lines are removed. */
function isClear(v: MetadataValue | null): boolean {
  return v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/**
 * Set fields in a front matter's YAML (null: the doc has none yet) and answer
 * the new YAML, or null when it would hold nothing. A field set to null, an
 * empty string or an empty list is removed. Only the lines of the fields set
 * change; a new field goes beside its schema neighbours.
 *
 * The caller checks the values first (`checkUpdates`); this only writes.
 */
export function setMetadataFields(
  schema: MetadataSchema,
  yaml: string | null,
  updates: Record<string, MetadataValue | null>,
): string | null {
  let lines = yaml === null || yaml === '' ? [] : yaml.split('\n');
  for (const field of schema.fields) {
    if (!(field.key in updates)) continue;
    const next = updates[field.key] ?? null;
    const entries = readFrontMatterEntries(lines.join('\n'));
    const prev = entries.find((e) => e.key === field.key);
    const repl = isClear(next) ? [] : fieldLines(field, next as MetadataValue, prev, lines);
    if (prev) {
      lines = [...lines.slice(0, prev.start), ...repl, ...lines.slice(prev.end)];
      continue;
    }
    if (repl.length === 0) continue;
    // Beside its neighbours in schema order: after the nearest earlier field
    // that is present, else before the nearest later one, else at the end.
    const order = schema.fields.map((f) => f.key);
    const at = order.indexOf(field.key);
    const present = new Map(entries.map((e) => [e.key, e]));
    let pos = lines.length;
    const before = order
      .slice(0, at)
      .reverse()
      .find((k) => present.has(k));
    if (before) pos = present.get(before)?.end ?? pos;
    else {
      const after = order.slice(at + 1).find((k) => present.has(k));
      if (after) pos = present.get(after)?.start ?? pos;
    }
    lines = [...lines.slice(0, pos), ...repl, ...lines.slice(pos)];
  }
  const out = lines.join('\n');
  return out.trim() === '' ? null : out;
}

/**
 * Judge a set request against the schema: every key a field, no read-only
 * field, every value the field's type. Answers the first problem per key.
 */
export function checkUpdates(
  schema: MetadataSchema,
  updates: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const byKey = new Map(schema.fields.map((f) => [f.key, f]));
  for (const [key, v] of Object.entries(updates)) {
    const field = byKey.get(key);
    if (!field) {
      errors[key] = 'is not a field in this doc’s schema';
      continue;
    }
    if (field.readOnly) {
      errors[key] = 'is read-only';
      continue;
    }
    if (v === null) continue;
    const err = checkValue(field, v as MetadataValue);
    if (err) errors[key] = err;
  }
  return errors;
}

/**
 * The YAML lines the parser keeps from between a file's two `---`: leading
 * and trailing blank lines dropped, interior ones kept so a file's front
 * matter comes back byte for byte. The one exception is the shape an old
 * parser left behind, a blank line after every value, which is dropped so
 * those docs heal on their next reparse.
 */
export function frontMatterLines(raw: readonly string[]): string[] {
  let a = 0;
  let b = raw.length;
  while (a < b && (raw[a] ?? '').trim() === '') a++;
  while (b > a && (raw[b - 1] ?? '').trim() === '') b--;
  const body = raw.slice(a, b);
  const alternating =
    body.length >= 3 && body.every((ln, k) => (k % 2 === 1) === (ln.trim() === ''));
  return alternating ? body.filter((ln) => ln.trim() !== '') : body;
}
