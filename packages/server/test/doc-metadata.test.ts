/**
 * A doc's metadata fields, end to end: a real server bound to a `.md` in a
 * temporary git repository that declares `.workspaces/doc-metadata.schema.json`.
 *
 * - The schema is found from the doc's folder upward, the nearest one wins,
 *   and the search stops at the repository's top.
 * - A set through the route writes the front matter on disk through the
 *   normal write-back, changing only that field's line, and reaches a page
 *   already open on the doc.
 * - A field edited in an open page (the editor's own edit: the front-matter
 *   block's text) reaches the file and another open page.
 * - Front matter that breaks the schema is reported per field, and the file
 *   keeps its bytes until somebody sets a field.
 * - A body edit leaves the front matter byte for byte.
 *
 * Fixtures are invented. Port 0, temp folders only.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { FRONT_MATTER_LANGUAGE } from '../../core/src/doc-metadata.ts';
import { getProseFragment } from '../../core/src/prose.ts';
import { findMetadataSchema, frontMatterOf } from '../src/doc-metadata.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { boundFiles } from '../src/slow-fs.ts';
import { type DocEditorSocket, connectDocEditor } from './doc-editor-socket.ts';
import { pastWriteBack, waitFor, waitForFileToBe } from './wait-for.ts';
import { seedBoard } from './workspace-seed.ts';

const SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', title: 'Title' },
    summary: { type: 'string' },
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

const DOC = [
  '---',
  '# fields the site build reads',
  'title: Harborlight fares',
  'status: draft',
  '',
  'authors:',
  '  - Alice',
  'layout: whitepaper',
  '---',
  '',
  '# Harborlight fares',
  '',
  'Riverbend riders pay at the door.',
  '',
].join('\n');

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_COMMITTER_DATE: '2026-03-04T10:00:00Z',
        GIT_AUTHOR_DATE: '2026-03-04T10:00:00Z',
      },
    },
  );
}

/** A repository with the schema at its top and the doc in `papers/`. */
function makeRepo(md: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'cw-doc-metadata-'));
  git(root, 'init', '-q');
  mkdirSync(join(root, '.workspaces'));
  writeFileSync(join(root, '.workspaces/doc-metadata.schema.json'), JSON.stringify(SCHEMA));
  mkdirSync(join(root, 'papers'));
  const path = join(root, 'papers/fares.md');
  writeFileSync(path, md);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'seed');
  return { root, path };
}

function frontMatterText(ydoc: Y.Doc): string | null {
  const first = getProseFragment(ydoc).get(0);
  if (!(first instanceof Y.XmlElement)) return null;
  if (first.getAttribute('language') !== FRONT_MATTER_LANGUAGE) return null;
  const t = first.get(0);
  return t instanceof Y.XmlText ? t.toString() : null;
}

describe('findMetadataSchema', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('takes the nearest schema, and stops at the repository top', () => {
    const outer = mkdtempSync(join(tmpdir(), 'cw-doc-metadata-walk-'));
    dirs.push(outer);
    // A schema ABOVE the repository must never be read.
    mkdirSync(join(outer, '.workspaces'));
    writeFileSync(join(outer, '.workspaces/doc-metadata.schema.json'), JSON.stringify(SCHEMA));
    const repo = join(outer, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'a/b'), { recursive: true });
    const md = join(repo, 'a/b/doc.md');
    writeFileSync(md, '# x\n');
    expect(findMetadataSchema(md, boundFiles.guards)).toEqual({ found: false });

    mkdirSync(join(repo, '.workspaces'));
    writeFileSync(
      join(repo, '.workspaces/doc-metadata.schema.json'),
      JSON.stringify({ properties: { top: { type: 'string' } } }),
    );
    mkdirSync(join(repo, 'a/.workspaces'));
    writeFileSync(
      join(repo, 'a/.workspaces/doc-metadata.schema.json'),
      JSON.stringify({ properties: { near: { type: 'string' } } }),
    );
    const got = findMetadataSchema(md, boundFiles.guards);
    expect(got).toMatchObject({ found: true, at: '../.workspaces/doc-metadata.schema.json' });
    expect('schema' in got && got.schema.fields.map((f) => f.key)).toEqual(['near']);
  });

  it('reports a schema it cannot use rather than ignoring it', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cw-doc-metadata-bad-'));
    dirs.push(repo);
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, '.workspaces'));
    writeFileSync(join(repo, '.workspaces/doc-metadata.schema.json'), '{ not json');
    writeFileSync(join(repo, 'doc.md'), '# x\n');
    expect(findMetadataSchema(join(repo, 'doc.md'), boundFiles.guards)).toMatchObject({
      found: true,
      error: 'the schema file is not valid JSON',
    });
  });
});

describe('doc metadata through a running server', () => {
  let handle: ServerHandle | null = null;
  let root = '';
  let dataDir = '';
  const sockets: DocEditorSocket[] = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    await handle?.stop();
    handle = null;
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function boot(md: string): Promise<{ base: string; ws: string; path: string }> {
    const repo = makeRepo(md);
    root = repo.root;
    dataDir = mkdtempSync(join(tmpdir(), 'cw-doc-metadata-data-'));
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://127.0.0.1:${handle.port}`;
    const ws = await seedBoard(base);
    const created = await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'fares', type: 'markdown', sourceUrl: repo.path }),
    });
    expect(created.ok).toBe(true);
    return { base, ws, path: repo.path };
  }

  const open = (base: string, ws: string): DocEditorSocket => {
    const s = connectDocEditor(`${base.replace('http', 'ws')}/workspaces/${ws}/docs/fares/y`, base);
    sockets.push(s);
    return s;
  };

  const put = (base: string, ws: string, fields: Record<string, unknown>) =>
    fetch(`${base}/workspaces/${ws}/docs/fares/metadata`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields }),
    });

  it('reads the schema, the values and the git default', async () => {
    const { base, ws } = await boot(DOC);
    const res = await fetch(`${base}/workspaces/${ws}/docs/fares/metadata`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.schemaAt).toBe('../.workspaces/doc-metadata.schema.json');
    expect(body.values).toEqual({
      title: 'Harborlight fares',
      status: 'draft',
      authors: ['Alice'],
    });
    expect(body.errors).toEqual({});
    expect(body.defaults).toEqual({ updated: '2026-03-04' });
  });

  it('a set writes only its line to disk, and reaches a page already open', async () => {
    const { base, ws, path } = await boot(DOC);
    const page = open(base, ws);
    await page.ready;

    const res = await put(base, ws, { status: 'published', order: 2, tags: ['fares'] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { values: unknown }).values).toMatchObject({
      status: 'published',
      order: 2,
      tags: ['fares'],
    });

    // The open page has it without a reload.
    await waitFor(() => frontMatterText(page.ydoc)?.includes('status: published'), {
      describe: 'the set on the open page',
    });

    // The file: the set lines changed, every other byte as it was.
    const want = DOC.replace('status: draft', 'status: published\norder: 2\ntags: [fares]');
    await waitForFileToBe(path, want);
  });

  it('a field edited in one open page reaches the file and the other page', async () => {
    const { base, ws, path } = await boot(DOC);
    const a = open(base, ws);
    const b = open(base, ws);
    await Promise.all([a.ready, b.ready]);

    // The editor's edit: the block's text, the field's characters only.
    const first = getProseFragment(a.ydoc).get(0) as Y.XmlElement;
    const text = first.get(0) as Y.XmlText;
    const at = text.toString().indexOf('Harborlight fares');
    a.ydoc.transact(() => {
      text.delete(at, 'Harborlight fares'.length);
      text.insert(at, 'Saltmarsh fares');
    });

    await waitFor(() => frontMatterText(b.ydoc)?.includes('title: Saltmarsh fares'), {
      describe: 'the field on the other open page',
    });
    await waitForFileToBe(path, DOC.replace('title: Harborlight fares', 'title: Saltmarsh fares'));
  });

  it('names each wrong field and leaves the file alone until a field is set', async () => {
    const bad = DOC.replace('title: Harborlight fares\n', '')
      .replace('status: draft', 'status: final')
      .replace('layout: whitepaper', 'order: soon');
    const { base, ws, path } = await boot(bad);
    const res = await fetch(`${base}/workspaces/${ws}/docs/fares/metadata`);
    const body = (await res.json()) as { errors: Record<string, string> };
    expect(body.errors).toEqual({
      title: 'is required',
      status: 'must be one of draft, teaser, published',
      order: 'must be a number',
    });

    // A set the schema refuses writes nothing and names the field.
    const refused = await put(base, ws, { order: 'soon', updated: '2026-01-01' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'invalid-fields',
      fields: { order: 'must be a number', updated: 'is read-only' },
    });

    // timed: proving the write-back does NOT fire after a read and a refused set.
    await new Promise((r) => setTimeout(r, pastWriteBack()));
    expect(readFileSync(path, 'utf8')).toBe(bad);

    // A person sets one field: only that line moves; the other wrong one stays.
    expect((await put(base, ws, { status: 'teaser' })).status).toBe(200);
    await waitForFileToBe(path, bad.replace('status: final', 'status: teaser'));
  });

  it('a body edit leaves the front matter byte for byte', async () => {
    const { base, ws, path } = await boot(DOC);
    const res = await fetch(`${base}/workspaces/${ws}/docs/fares/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'pay at the door', replace: 'tap a card' }),
    });
    expect(res.status).toBe(200);
    await waitForFileToBe(path, DOC.replace('pay at the door', 'tap a card'));
  });

  it('a doc with no front matter gets a block when the first field is set', async () => {
    const { base, ws, path } = await boot('# Riverbend\n\nBody.\n');
    const page = open(base, ws);
    await page.ready;
    expect((await put(base, ws, { title: 'Riverbend' })).status).toBe(200);
    await waitFor(() => frontMatterText(page.ydoc) === 'title: Riverbend', {
      describe: 'the new block on the open page',
    });
    await waitForFileToBe(path, '---\ntitle: Riverbend\n---\n\n# Riverbend\n\nBody.\n');
  });

  it('a doc no schema governs answers null, and refuses a set', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-doc-metadata-none-'));
    root = mkdtempSync(join(tmpdir(), 'cw-doc-metadata-none-root-'));
    mkdirSync(join(root, '.git'));
    const path = join(root, 'plain.md');
    writeFileSync(path, DOC);
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    const base = `http://127.0.0.1:${handle.port}`;
    const ws = await seedBoard(base);
    await fetch(`${base}/workspaces/${ws}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'fares', type: 'markdown', sourceUrl: path }),
    });
    const got = await (await fetch(`${base}/workspaces/${ws}/docs/fares/metadata`)).json();
    expect(got).toMatchObject({ schema: null });
    expect(got).not.toHaveProperty('values');
    const refused = await put(base, ws, { title: 'x' });
    expect(refused.status).toBe(409);
  });
});

describe('frontMatterOf', () => {
  it('is null for a doc whose first block is not front matter', () => {
    const ydoc = new Y.Doc();
    expect(frontMatterOf(ydoc)).toBeNull();
  });
});
