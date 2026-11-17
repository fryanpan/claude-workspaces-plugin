import { prose } from '@claude-workspaces/core';
import { type MetadataSchema, parseMetadataSchema } from '@claude-workspaces/core/doc-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { mountDocMetadata, mountMetadataForm } from '../src/doc/doc-metadata.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';

/**
 * The metadata form over the real editor, on a fragment parsed the way the
 * server parses a bound file. A remote page is a second Y.Doc wired to the
 * first by updates, which is what the socket does. Fixtures are fictional.
 */

const SCHEMA = parseMetadataSchema({
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', title: 'Title' },
    status: { type: 'string', title: 'Status', enum: ['draft', 'teaser', 'published'] },
    updated: {
      type: 'string',
      format: 'date',
      readOnly: true,
      'x-workspaces-default': 'git-last-modified',
    },
    order: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
  },
});
if (!SCHEMA.ok) throw new Error(SCHEMA.error);
const schema: MetadataSchema = SCHEMA.schema;

const DOC = [
  '---',
  '# site fields',
  'title: Harborlight fares',
  'status: draft',
  'layout: whitepaper',
  '---',
  '',
  '# Harborlight fares',
  '',
  'Riverbend riders pay at the door.',
  '',
].join('\n');

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
});

function mount(md = DOC, canWrite = true) {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  const handle: EditorHandle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
  open.push(() => handle.destroy());
  const form = mountMetadataForm({
    editor: handle.editor,
    editorMount: parent,
    schema,
    defaults: { updated: '2026-03-04' },
    canWrite,
  });
  open.push(() => form.destroy());
  return { ydoc, parent, form };
}

const markdown = (ydoc: Y.Doc) => prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));

function control<T extends HTMLElement = HTMLInputElement>(key: string): T {
  const c = document.querySelector<T>(
    `.doc-metadata-field[data-field="${key}"] .doc-metadata-control`,
  );
  if (!c) throw new Error(`no control for ${key}`);
  return c;
}
const errorOf = (key: string) =>
  document.querySelector(`.doc-metadata-field[data-field="${key}"] .doc-metadata-error`)
    ?.textContent;

/** Type into a control the way a person does: focus, value, input, blur. */
function type(key: string, value: string): void {
  const c = control<HTMLInputElement | HTMLSelectElement>(key);
  c.focus();
  c.value = value;
  c.dispatchEvent(new Event(c instanceof HTMLSelectElement ? 'change' : 'input'));
  c.blur();
}

describe('the metadata form', () => {
  it('draws one control per field, above the prose, with the file values', () => {
    const { parent } = mount();
    const section = parent.querySelector('.doc-metadata');
    expect(section?.nextElementSibling?.classList.contains('ProseMirror')).toBe(true);
    expect(parent.classList.contains('has-doc-metadata')).toBe(true);
    expect(control('title').value).toBe('Harborlight fares');
    expect(control<HTMLSelectElement>('status').value).toBe('draft');
    expect(control('updated').type).toBe('date');
    expect(control('order').inputMode).toBe('decimal');
    // A blank git-default field shows the default, read-only.
    expect(control('updated').value).toBe('2026-03-04');
    expect(control('updated').disabled).toBe(true);
    expect(errorOf('title')).toBe('');
  });

  it('a field set here rewrites only its line in the doc', () => {
    const { ydoc } = mount();
    type('status', 'published');
    expect(markdown(ydoc)).toBe(DOC.replace('status: draft', 'status: published'));
    type('tags', 'fares, transit');
    expect(markdown(ydoc)).toBe(
      // Beside its schema neighbour, not at the end.
      DOC.replace('status: draft', 'status: published\ntags: [fares, transit]'),
    );
  });

  it('a field set on another page redraws here without a reload', () => {
    const { ydoc } = mount();
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    remote.on('update', (u: Uint8Array) => Y.applyUpdate(ydoc, u, 'remote'));
    const block = prose.getProseFragment(remote).get(0) as Y.XmlElement;
    const text = block.get(0) as Y.XmlText;
    const at = text.toString().indexOf('draft');
    remote.transact(() => {
      text.delete(at, 'draft'.length);
      text.insert(at, 'teaser');
    });
    expect(control<HTMLSelectElement>('status').value).toBe('teaser');
  });

  it('never overwrites a control a person is typing in', () => {
    const { ydoc } = mount();
    const title = control('title');
    title.focus();
    title.value = 'Saltmarsh';
    const block = prose.getProseFragment(ydoc).get(0) as Y.XmlElement;
    const text = block.get(0) as Y.XmlText;
    ydoc.transact(() => text.insert(text.length, '\norder: 4'), 'remote');
    expect(title.value).toBe('Saltmarsh');
    expect(control('order').value).toBe('4');
  });

  it('names the wrong field beside its label and leaves the doc alone', () => {
    const bad = DOC.replace('title: Harborlight fares\n', '')
      .replace('status: draft', 'status: final')
      .replace('layout: whitepaper', 'order: soon');
    const { ydoc } = mount(bad);
    expect(errorOf('title')).toBe('Required');
    expect(errorOf('status')).toBe('Must be one of draft, teaser, published');
    expect(control<HTMLSelectElement>('status').value).toBe('final');
    expect(control('order').value).toBe('soon');
    expect(errorOf('order')).toBe('Must be a number');
    expect(control('title').getAttribute('aria-invalid')).not.toBeNull();
    expect(markdown(ydoc)).toBe(bad);
  });

  it('a doc with no front matter gets a block when a field is set', () => {
    const { ydoc } = mount('# Riverbend\n\nBody.\n');
    expect(errorOf('title')).toBe('Required');
    type('title', 'Riverbend');
    expect(markdown(ydoc)).toBe('---\ntitle: Riverbend\n---\n\n# Riverbend\n\nBody.\n');
    expect(errorOf('title')).toBe('');
  });

  it('a reader who cannot write sees the values and cannot change them', () => {
    mount(DOC, false);
    expect(control('title').disabled).toBe(true);
    expect(control<HTMLSelectElement>('status').disabled).toBe(true);
  });
});

describe('mountDocMetadata', () => {
  it('draws nothing when no schema governs the doc', async () => {
    const ydoc = new Y.Doc();
    prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(DOC));
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
    open.push(() => handle.destroy());
    let loaded = false;
    mountDocMetadata({
      editor: handle.editor,
      editorMount: parent,
      docId: 'd-1',
      canWrite: true,
      onCleanup: (fn) => open.push(fn),
      load: async () => {
        loaded = true;
        return { schema: null };
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(loaded).toBe(true);
    expect(parent.querySelector('.doc-metadata')).toBeNull();
    expect(parent.classList.contains('has-doc-metadata')).toBe(false);
  });
});
