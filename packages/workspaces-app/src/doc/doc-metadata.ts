/**
 * A doc's metadata fields, as a compact form at the top of the doc.
 *
 * The fields are the ones the schema declares (core `doc-metadata.ts`;
 * contract docs/architecture/doc-metadata.md). The server finds the schema
 * and the git default; this module reads the VALUES live from the editor,
 * because the front matter is the doc's first block, a `codeBlock` in
 * `yaml-frontmatter`. So a field set by an agent or another tab arrives as a
 * Yjs edit to that block and redraws here in the same frame, and a field set
 * here is a text edit to that block that travels the same way and reaches the
 * file on the next write-back.
 *
 * With no schema nothing is drawn and the editor shows the front matter as
 * it always has. With one, the raw block is hidden (`has-doc-metadata`).
 *
 * Reading never writes: a value that breaks the schema is shown with what is
 * wrong beside its label, and the block's text changes only when a person
 * sets a field. Each control keeps its size whatever it holds, and the error
 * sits on the label's line, so a wrong value moves nothing.
 */
import {
  FRONT_MATTER_LANGUAGE,
  type MetadataField,
  type MetadataSchema,
  type MetadataValue,
  readFrontMatterEntries,
  readMetadata,
  setMetadataFields,
} from '@claude-workspaces/core/doc-metadata';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { api } from '../doc-path.ts';
import { suggestInputKey } from '../suggest-input.ts';

/** On `#editor` while the form stands in for the raw front matter. */
export const HAS_METADATA_CLASS = 'has-doc-metadata';

/** What the server answers for the doc (`routes/doc-metadata.ts`). */
export interface MetadataAnswer {
  schema: MetadataSchema | null;
  defaults?: Record<string, string>;
}

export interface MetadataFormDeps {
  editor: Editor;
  /** `#editor`: the form goes in front of the prose. */
  editorMount: HTMLElement;
  schema: MetadataSchema;
  defaults: Record<string, string>;
  canWrite: boolean;
}

export interface MetadataFormHandle {
  el: HTMLElement;
  destroy(): void;
}

function frontMatterNode(doc: PMNode): PMNode | null {
  const first = doc.firstChild;
  return first && first.type.name === 'codeBlock' && first.attrs.language === FRONT_MATTER_LANGUAGE
    ? first
    : null;
}

/** The YAML the editor holds, or null when the doc has no front matter. */
export function editorFrontMatter(editor: Editor): string | null {
  return frontMatterNode(editor.state.doc)?.textContent ?? null;
}

/** Write `next` as the doc's front matter: patch, create or remove the block. */
function writeFrontMatter(editor: Editor, next: string | null): void {
  const { state } = editor;
  const node = frontMatterNode(state.doc);
  const tr = state.tr;
  if (node) {
    if (next === null) {
      if (state.doc.childCount === 1) {
        tr.replaceWith(0, node.nodeSize, state.schema.nodes.paragraph.create());
      } else tr.delete(0, node.nodeSize);
    } else {
      const prev = node.textContent;
      let head = 0;
      while (head < prev.length && head < next.length && prev[head] === next[head]) head++;
      let tail = 0;
      while (
        tail < prev.length - head &&
        tail < next.length - head &&
        prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
      )
        tail++;
      const from = 1 + head;
      const to = 1 + prev.length - tail;
      const inserted = next.slice(head, next.length - tail);
      if (inserted) tr.insertText(inserted, from, to);
      else if (to > from) tr.delete(from, to);
      else return;
    }
  } else {
    if (next === null) return;
    const codeBlock = state.schema.nodes.codeBlock;
    if (!codeBlock) return;
    tr.insert(0, codeBlock.create({ language: FRONT_MATTER_LANGUAGE }, state.schema.text(next)));
  }
  // A field is set directly even in Suggesting mode, as a choice pick is: it
  // is an answer about the doc, not a proposed change to its words.
  tr.setMeta(suggestInputKey, { handled: true });
  editor.view.dispatch(tr);
}

type Control = HTMLInputElement | HTMLSelectElement;

/** Core's "is required" / "must be …", as the words beside a label. */
function sentence(message: string): string {
  const s = message === 'is required' ? 'required' : message;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface Row {
  field: MetadataField;
  control: Control;
  error: HTMLElement;
}

/** What a control shows for a value, or for the raw text when it is wrong. */
function shown(v: MetadataValue | undefined, raw: string): string {
  if (v === undefined) return raw;
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

/** The value a control holds, or `undefined` when it holds nothing valid. */
function readControl(field: MetadataField, control: Control): MetadataValue | null | undefined {
  const s = control.value.trim();
  if (s === '') return null;
  switch (field.type) {
    case 'number': {
      const n = Number(s);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return s === 'true';
    case 'string[]':
      return s
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x !== '');
    default:
      return control.value;
  }
}

function buildControl(field: MetadataField, id: string): Control {
  if (field.enum || field.type === 'boolean') {
    const select = document.createElement('select');
    const options = field.enum ?? ['true', 'false'];
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '—';
    select.append(blank);
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = field.type === 'boolean' ? (o === 'true' ? 'Yes' : 'No') : o;
      select.append(opt);
    }
    select.id = id;
    return select;
  }
  const input = document.createElement('input');
  input.id = id;
  // A number is a text box with the decimal keypad: a number input cannot
  // show a wrong value, and the reader has to see what the file holds.
  input.type = field.format === 'date' ? 'date' : 'text';
  if (field.type === 'number') input.inputMode = 'decimal';
  input.autocomplete = 'off';
  input.spellcheck = field.type === 'string' && !field.format;
  const hint = field.description ?? (field.type === 'string[]' ? 'Comma-separated' : '');
  if (hint && input.type === 'text') input.placeholder = hint;
  return input;
}

/** Put `value` in a select, adding a marked option for a value it lacks. */
function setSelect(select: HTMLSelectElement, value: string): void {
  for (const o of [...select.options]) if (o.dataset.extra === '1') o.remove();
  if (value !== '' && ![...select.options].some((o) => o.value === value)) {
    const extra = document.createElement('option');
    extra.value = value;
    extra.textContent = value;
    extra.dataset.extra = '1';
    select.append(extra);
  }
  select.value = value;
}

/** Draw the form for `schema` and keep it in step with the editor. */
export function mountMetadataForm(deps: MetadataFormDeps): MetadataFormHandle {
  const { editor, editorMount, schema, defaults, canWrite } = deps;
  const section = document.createElement('section');
  section.className = 'doc-metadata';
  section.setAttribute('aria-label', schema.title ?? 'Details');
  const grid = document.createElement('div');
  grid.className = 'doc-metadata-fields';
  section.append(grid);

  const rows: Row[] = schema.fields.map((field, i) => {
    const cell = document.createElement('div');
    cell.className = 'doc-metadata-field';
    cell.dataset.field = field.key;
    const head = document.createElement('div');
    head.className = 'doc-metadata-head';
    const label = document.createElement('label');
    const id = `doc-metadata-${i}`;
    label.htmlFor = id;
    label.textContent = field.title;
    if (field.description) label.title = field.description;
    const error = document.createElement('span');
    error.className = 'doc-metadata-error';
    error.id = `${id}-error`;
    head.append(label, error);
    const control = buildControl(field, id);
    control.className = 'doc-metadata-control';
    control.setAttribute('aria-describedby', error.id);
    if (field.required) control.setAttribute('aria-required', 'true');
    control.disabled = field.readOnly || !canWrite;
    cell.append(head, control);
    grid.append(cell);
    return { field, control, error };
  });

  let drawn: string | null | undefined;
  const render = (force = false) => {
    const yaml = editorFrontMatter(editor);
    if (!force && yaml === drawn) return;
    drawn = yaml;
    const { values, errors } = readMetadata(schema, yaml);
    const raw = new Map<string, string>();
    for (const e of yaml === null ? [] : readFrontMatterEntries(yaml)) {
      if (raw.has(e.key)) continue;
      const v = e.value;
      raw.set(e.key, v.kind === 'scalar' ? v.text : v.kind === 'list' ? v.items.join(', ') : '');
    }
    for (const { field, control, error } of rows) {
      const message = errors[field.key];
      error.textContent = message ? sentence(message) : '';
      control.toggleAttribute('aria-invalid', Boolean(message));
      const cell = control.parentElement;
      cell?.classList.toggle('is-invalid', Boolean(message));
      // Never overwrite what a person is typing; their own edit already is
      // the doc's value.
      if (control === document.activeElement) continue;
      let text = shown(values[field.key], raw.get(field.key) ?? '');
      const fallback = field.defaultFrom ? defaults[field.key] : undefined;
      const isDefault = text === '' && fallback !== undefined;
      if (isDefault) text = fallback ?? '';
      cell?.classList.toggle('is-default', isDefault);
      if (control instanceof HTMLSelectElement) setSelect(control, text);
      else if (control.value !== text) control.value = text;
    }
  };

  const onInput = (row: Row) => () => {
    if (!canWrite || row.field.readOnly) return;
    const v = readControl(row.field, row.control);
    if (v === undefined) {
      row.error.textContent = sentence('must be a number');
      return;
    }
    const before = editorFrontMatter(editor);
    const next = setMetadataFields(schema, before, { [row.field.key]: v });
    if (next !== before) writeFrontMatter(editor, next);
    render(true);
  };
  const listeners: Array<() => void> = [];
  for (const row of rows) {
    const h = onInput(row);
    const type = row.control instanceof HTMLSelectElement ? 'change' : 'input';
    row.control.addEventListener(type, h);
    listeners.push(() => row.control.removeEventListener(type, h));
    // The control's own redraw was skipped while it had focus.
    const blur = () => render(true);
    row.control.addEventListener('blur', blur);
    listeners.push(() => row.control.removeEventListener('blur', blur));
  }

  const onTransaction = () => render();
  editor.on('transaction', onTransaction);
  const pm = editor.view.dom;
  if (pm.parentElement === editorMount) pm.before(section);
  else editorMount.prepend(section);
  editorMount.classList.add(HAS_METADATA_CLASS);
  render(true);

  return {
    el: section,
    destroy() {
      editor.off('transaction', onTransaction);
      for (const off of listeners) off();
      section.remove();
      editorMount.classList.remove(HAS_METADATA_CLASS);
    },
  };
}

export interface DocMetadataDeps {
  editor: Editor;
  editorMount: HTMLElement;
  docId: string;
  canWrite: boolean;
  onCleanup: (fn: () => void) => void;
  /** Injected for the test; `fetch` of the doc's metadata in the browser. */
  load?: (docId: string) => Promise<MetadataAnswer | null>;
}

async function loadMetadata(docId: string): Promise<MetadataAnswer | null> {
  try {
    const res = await fetch(api(`docs/${encodeURIComponent(docId)}/metadata`), {
      credentials: 'same-origin',
    });
    return res.ok ? ((await res.json()) as MetadataAnswer) : null;
  } catch {
    return null;
  }
}

/**
 * Ask the server whether a schema governs the doc, and draw the form if one
 * does. Nothing is drawn, and the editor is as it was, when none does or the
 * read fails.
 */
export function mountDocMetadata(deps: DocMetadataDeps): void {
  let handle: MetadataFormHandle | null = null;
  let gone = false;
  deps.onCleanup(() => {
    gone = true;
    handle?.destroy();
  });
  void (deps.load ?? loadMetadata)(deps.docId).then((answer) => {
    if (gone || !answer?.schema || answer.schema.fields.length === 0) return;
    if (deps.editor.isDestroyed) return;
    handle = mountMetadataForm({
      editor: deps.editor,
      editorMount: deps.editorMount,
      schema: answer.schema,
      defaults: answer.defaults ?? {},
      canWrite: deps.canWrite,
    });
  });
}
