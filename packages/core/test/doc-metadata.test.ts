import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  type MetadataSchema,
  checkUpdates,
  frontMatterLines,
  parseMetadataSchema,
  readFrontMatterEntries,
  readMetadata,
  setMetadataFields,
} from '../src/doc-metadata.ts';
import {
  getProseFragment,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
} from '../src/prose.ts';

/** The fields the SF Works site build reads (docs/architecture/doc-metadata.md). */
const FIXTURE = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', title: 'Title' },
    summary: { type: 'string', description: 'One or two sentences.' },
    status: { type: 'string', enum: ['draft', 'teaser', 'published'] },
    updated: {
      type: 'string',
      format: 'date',
      readOnly: true,
      'x-workspaces-default': 'git-last-modified',
    },
    published: { type: 'string', format: 'date' },
    series: { type: 'string' },
    order: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
    authors: { type: 'array', items: { type: 'string' } },
  },
};

function schema(): MetadataSchema {
  const got = parseMetadataSchema(FIXTURE);
  if (!got.ok) throw new Error(got.error);
  return got.schema;
}

describe('parseMetadataSchema', () => {
  it('reads every field of the fixture schema in order', () => {
    const s = schema();
    expect(s.fields.map((f) => [f.key, f.type])).toEqual([
      ['title', 'string'],
      ['summary', 'string'],
      ['status', 'string'],
      ['updated', 'string'],
      ['published', 'string'],
      ['series', 'string'],
      ['order', 'number'],
      ['tags', 'string[]'],
      ['authors', 'string[]'],
    ]);
    const updated = s.fields.find((f) => f.key === 'updated');
    expect(updated).toMatchObject({
      format: 'date',
      readOnly: true,
      defaultFrom: 'git-last-modified',
      required: false,
    });
    expect(s.fields[0]).toMatchObject({ title: 'Title', required: true });
    expect(s.fields[2]?.enum).toEqual(['draft', 'teaser', 'published']);
  });

  it('refuses a type outside the subset, naming the field', () => {
    const got = parseMetadataSchema({ properties: { meta: { type: 'object' } } });
    expect(got).toEqual({ ok: false, error: expect.stringContaining('"meta"') });
  });

  it('refuses a git default on anything but a string', () => {
    const got = parseMetadataSchema({
      properties: { n: { type: 'number', 'x-workspaces-default': 'git-last-modified' } },
    });
    expect(got.ok).toBe(false);
  });
});

describe('readMetadata', () => {
  it('reads scalars, quoted strings, flow and block lists', () => {
    const yaml = [
      'title: "Harborlight: a study"',
      "summary: It's short # a comment",
      'status: draft',
      'published: 2026-11-01',
      'order: 3',
      'tags: [transit, "fares, policy"]',
      'authors:',
      '  - Alice',
      '  - Bob',
    ].join('\n');
    const r = readMetadata(schema(), yaml);
    expect(r.errors).toEqual({});
    expect(r.values).toEqual({
      title: 'Harborlight: a study',
      summary: "It's short",
      status: 'draft',
      published: '2026-11-01',
      order: 3,
      tags: ['transit', 'fares, policy'],
      authors: ['Alice', 'Bob'],
    });
  });

  it('names each wrong field and what is wrong with it', () => {
    const yaml = [
      'summary: 42',
      'status: final',
      'published: November',
      'order: three',
      'tags: transit',
    ].join('\n');
    const r = readMetadata(schema(), yaml);
    expect(r.errors).toEqual({
      title: 'is required',
      summary: 'must be text',
      status: 'must be one of draft, teaser, published',
      published: 'must be a date (YYYY-MM-DD)',
      order: 'must be a number',
      tags: 'must be a list',
    });
  });

  it('reports a nested map as unreadable and keeps going', () => {
    const r = readMetadata(schema(), 'title: Riverbend\nseries:\n  name: x\norder: 2');
    expect(r.errors.series).toContain('cannot be read');
    expect(r.values).toEqual({ title: 'Riverbend', order: 2 });
  });

  it('with no front matter, only required fields are wrong', () => {
    expect(readMetadata(schema(), null)).toEqual({
      values: {},
      errors: { title: 'is required' },
    });
  });
});

describe('setMetadataFields', () => {
  it('rewrites only the field set, keeping comments, unknown keys and order', () => {
    const yaml = [
      '# written by hand',
      'title: Saltmarsh',
      'layout: post',
      'status: draft # not yet',
      'authors:',
      '    - Alice',
    ].join('\n');
    const out = setMetadataFields(schema(), yaml, { status: 'published' });
    expect(out).toBe(
      [
        '# written by hand',
        'title: Saltmarsh',
        'layout: post',
        'status: published',
        'authors:',
        '    - Alice',
      ].join('\n'),
    );
  });

  it('keeps a block list a block list, at its indent', () => {
    const yaml = 'title: Saltmarsh\nauthors:\n    - Alice';
    expect(setMetadataFields(schema(), yaml, { authors: ['Alice', 'Bob'] })).toBe(
      'title: Saltmarsh\nauthors:\n    - Alice\n    - Bob',
    );
  });

  it('puts a new field beside its schema neighbours', () => {
    const yaml = 'title: Saltmarsh\norder: 2';
    expect(setMetadataFields(schema(), yaml, { status: 'teaser' })).toBe(
      'title: Saltmarsh\nstatus: teaser\norder: 2',
    );
    expect(setMetadataFields(schema(), 'order: 2', { title: 'Riverbend' })).toBe(
      'title: Riverbend\norder: 2',
    );
  });

  it('quotes text a YAML reader would take for something else', () => {
    const out = setMetadataFields(schema(), null, {
      title: 'Harborlight: part 2',
      summary: '2026',
      series: 'true',
      tags: ['a, b', 'plain'],
      published: '2026-11-12',
    });
    expect(out).toBe(
      [
        'title: "Harborlight: part 2"',
        'summary: "2026"',
        'published: 2026-11-12',
        'series: "true"',
        'tags: ["a, b", plain]',
      ].join('\n'),
    );
    // And reads back as written.
    expect(readMetadata(schema(), out).values).toMatchObject({
      title: 'Harborlight: part 2',
      summary: '2026',
      series: 'true',
      tags: ['a, b', 'plain'],
    });
  });

  it('removes a cleared field, and answers null when nothing is left', () => {
    expect(setMetadataFields(schema(), 'title: A\nseries: B', { series: null })).toBe('title: A');
    expect(setMetadataFields(schema(), 'title: A', { title: '' })).toBeNull();
  });
});

describe('checkUpdates', () => {
  it('refuses unknown, read-only and wrongly typed fields', () => {
    expect(
      checkUpdates(schema(), {
        nope: 'x',
        updated: '2026-01-01',
        order: '3',
        tags: 'a',
        status: 'final',
        title: 'Fine',
        series: null,
      }),
    ).toEqual({
      nope: expect.stringContaining('not a field'),
      updated: 'is read-only',
      order: 'must be a number',
      tags: 'must be a list of text',
      status: 'must be one of draft, teaser, published',
    });
  });
});

describe('front matter through the markdown model', () => {
  function roundTrip(md: string): string {
    const doc = new Y.Doc();
    const fragment = getProseFragment(doc);
    doc.transact(() => fragment.push(parseMarkdownBlocks(md)));
    return serializeFragmentToMarkdown(fragment);
  }

  it('comes back byte for byte, comments and inner blank lines included', () => {
    const md =
      '---\n# site fields\ntitle: Riverbend\n\ntags:\n  - a\n  - b\nlayout: post\n---\n\n# Body\n';
    expect(roundTrip(md)).toBe(md);
  });

  it('keeps only the lines, dropping blank lines at either end', () => {
    expect(frontMatterLines(['', 'a: 1', 'b: 2', ''])).toEqual(['a: 1', 'b: 2']);
  });

  it('reads entries with their line ranges', () => {
    const e = readFrontMatterEntries('a: 1\nb:\n  - x\n\nc: "y"');
    expect(e.map((x) => [x.key, x.start, x.end])).toEqual([
      ['a', 0, 1],
      ['b', 1, 3],
      ['c', 4, 5],
    ]);
  });
});
