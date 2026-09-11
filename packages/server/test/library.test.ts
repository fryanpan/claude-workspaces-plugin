/**
 * The board's Library: which docs are meetings and which are files, which
 * project files it offers beyond the board's own docs, and what the open verb
 * will and will not bind.
 *
 * The first block drives `buildLibrary` over hand-built sources; the second
 * drives the real routes against a real git repo. Every refusal in the second
 * is paired with a positive control on the same server — a listed file opens —
 * so a 404 cannot be a listing that never built.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocMeta } from '@claude-workspaces/core';
import { makeDocKey } from '../src/doc-key.ts';
import {
  type LibraryPayload,
  type LibrarySources,
  abbreviateHome,
  buildLibrary,
  displayNames,
  openableFiles,
} from '../src/library.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

const REPO = 'git:example.com/harborlight/riverbend';

function meta(docId: string, extra: Partial<DocMeta> = {}): DocMeta {
  return { docId, type: 'markdown', createdAt: 1_000, ...extra };
}

function sources(over: Partial<LibrarySources> = {}): LibrarySources {
  return {
    workspaceId: 'w-test',
    docs: [],
    docKeyOf: () => undefined,
    lastMeetingAt: () => undefined,
    projectRoot: () => '/box/dev/riverbend',
    markdownFiles: () => [],
    mountedFiles: () => [],
    home: '/box',
    ...over,
  };
}

describe('buildLibrary', () => {
  it('puts a doc that held a meeting, or a discussion huddle, under meetings — and a plan under files', () => {
    const lib = buildLibrary(
      sources({
        docs: [
          meta('d-sync', { title: 'Harborlight weekly sync' }),
          meta('d-talk', { title: 'Trail map review', huddle: true, huddleKind: 'discussion' }),
          meta('d-plan', { title: 'Saltmarsh plan', huddle: true, huddleKind: 'plan' }),
          meta('d-note', { title: 'Volunteer handbook', lastActivityAt: 5_000 }),
        ],
        lastMeetingAt: (id) => (id === 'd-sync' ? 9_000 : undefined),
      }),
    );
    expect(lib.meetings.map((r) => [r.name, r.at])).toEqual([
      ['Harborlight weekly sync', 9_000],
      ['Trail map review', 1_000],
    ]);
    expect(lib.files.map((r) => r.name)).toEqual(['Volunteer handbook', 'Saltmarsh plan']);
    expect(lib.meetings[0]?.href).toBe('/workspaces/w-test/docs/d-sync');
  });

  it("leaves out a review's members and the board's own namespaces", () => {
    const lib = buildLibrary(
      sources({
        docs: [
          meta('r-1:notes~a.md', { setId: 'r-1', relPath: 'notes/a.md' }),
          meta('task:t-1', { title: 'A task body' }),
          meta('d-kept', { title: 'Kept' }),
        ],
      }),
    );
    expect(lib.files.map((r) => r.name)).toEqual(['Kept']);
  });

  it('offers every project markdown file no board doc holds, and a mounted file at its address', () => {
    const docs = [meta('d-plan', { title: 'Riverbend project plan' })];
    const keys: Record<string, string> = { 'd-plan': makeDocKey(REPO, 'docs/plan.md') };
    const lib = buildLibrary(
      sources({
        docs,
        docKeyOf: (id) => keys[id],
        markdownFiles: () => [
          { relPath: 'docs/plan.md', mtimeMs: 2_000 },
          { relPath: 'README.md', mtimeMs: 3_000 },
          { relPath: 'docs/guide/README.md', mtimeMs: 4_000 },
        ],
        mountedFiles: () => [
          { fileId: 'f-1', relPath: '.workspace/site-plan-430.png', mtimeMs: 6_000 },
          { fileId: 'f-2', relPath: 'README.md', mtimeMs: 3_000 },
        ],
      }),
    );
    expect(lib.project).toEqual({ name: 'riverbend', path: '~/dev/riverbend' });
    expect(lib.files).toEqual([
      { name: 'site-plan-430.png', at: 6_000, href: '/mounts/f-1/raw' },
      { name: 'guide/README.md', at: 4_000, open: 'docs/guide/README.md' },
      // Not `./README.md`: a root file keeps its bare name.
      { name: 'README.md', at: 3_000, open: 'README.md' },
      { name: 'Riverbend project plan', at: 1_000, href: '/workspaces/w-test/docs/d-plan' },
    ]);
  });

  it("takes the project from the board's own docs, not a review's members", () => {
    const other = 'git:example.com/harborlight/saltmarsh';
    const keys: Record<string, string> = {
      'd-plan': makeDocKey(REPO, 'docs/plan.md'),
      'r-1:a.md': makeDocKey(other, 'a.md'),
      'r-1:b.md': makeDocKey(other, 'b.md'),
      'task:t-1': makeDocKey(other, 'c.md'),
    };
    const lib = buildLibrary(
      sources({
        docs: [
          meta('d-plan', { title: 'Riverbend project plan' }),
          meta('r-1:a.md', { setId: 'r-1', relPath: 'a.md' }),
          meta('r-1:b.md', { setId: 'r-1', relPath: 'b.md' }),
          meta('task:t-1', { title: 'A task body' }),
        ],
        docKeyOf: (id) => keys[id],
      }),
    );
    // Three docs of the other repo against one of this board's — and the
    // board's own doc still names the project.
    expect(lib.project?.name).toBe('riverbend');
  });

  it('lists no project files for a board whose docs sit in no repo', () => {
    let asked = false;
    const lib = buildLibrary(
      sources({
        docs: [meta('d-loose', { title: 'Loose note' })],
        markdownFiles: () => {
          asked = true;
          return [{ relPath: 'x.md', mtimeMs: 1 }];
        },
      }),
    );
    expect(lib.project).toBeNull();
    expect(asked).toBe(false);
    expect(lib.files.map((r) => r.name)).toEqual(['Loose note']);
  });
});

describe('library helpers', () => {
  it('names a file by its folder only when the bare name is ambiguous', () => {
    const names = displayNames(['README.md', 'a/README.md', 'a/b/notes.md']);
    expect([...names.values()]).toEqual(['README.md', 'a/README.md', 'notes.md']);
  });

  it('keeps adding folders until each ambiguous name is one file', () => {
    const names = displayNames([
      'client/docs/README.md',
      'server/docs/README.md',
      'docs/README.md',
      'plan.md',
    ]);
    // One folder would leave the first two BOTH reading `docs/README.md`.
    expect([...names.values()]).toEqual([
      'client/docs/README.md',
      'server/docs/README.md',
      'docs/README.md',
      'plan.md',
    ]);
  });

  it('offers a mounted markdown file to open, naming the mount it came from', () => {
    const offered = openableFiles(
      sources({
        docs: [meta('d-plan', { title: 'Plan' })],
        docKeyOf: () => makeDocKey(REPO, 'docs/plan.md'),
        markdownFiles: () => [
          { relPath: 'docs/plan.md', mtimeMs: 1 },
          { relPath: 'README.md', mtimeMs: 2 },
        ],
        mountedFiles: () => [
          { fileId: 'f-side', relPath: 'notes/side.md', mtimeMs: 3 },
          { fileId: 'f-png', relPath: 'notes/shot.png', mtimeMs: 4 },
        ],
      }),
    );
    // The repo's own listing answers null — its bytes are under the project
    // root. The mounted one answers its address, because its bytes are not.
    expect([...offered]).toEqual([
      ['README.md', null],
      ['notes/side.md', 'f-side'],
    ]);
  });

  it('abbreviates the home directory and nothing that merely starts with it', () => {
    expect(abbreviateHome('/box/dev/p', '/box')).toBe('~/dev/p');
    expect(abbreviateHome('/boxed/p', '/box')).toBe('/boxed/p');
  });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

describe('library routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let WS = '';

  const at = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
    });
  const items = async (): Promise<LibraryPayload> => {
    const res = await at(`/workspaces/${WS}/library/items`);
    expect(res.status).toBe(200);
    return (await res.json()) as LibraryPayload;
  };
  const open = (path: string) =>
    at(`/workspaces/${WS}/library/open`, { method: 'POST', body: JSON.stringify({ path }) });

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'library-data-'));
    repo = mkdtempSync(join(tmpdir(), 'library-repo-'));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, '.gitignore'), 'private/\n');
    writeFileSync(join(repo, 'handbook.md'), '# Volunteer handbook\n');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'tide-gauge.md'), '# Tide gauge\n');
    mkdirSync(join(repo, 'private'));
    writeFileSync(join(repo, 'private', 'hidden.md'), 'FIXTURE_MARKER\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    handle = createServer({ port: 0, dataDir });
    WS = await seedBoard(`http://127.0.0.1:${handle.port}`);
    const bound = await at(`/workspaces/${WS}/docs`, {
      method: 'POST',
      body: JSON.stringify({
        docId: 'handbook',
        type: 'markdown',
        sourceUrl: join(repo, 'handbook.md'),
        title: 'Volunteer handbook',
      }),
    });
    expect(bound.status).toBe(200);
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(`${repo}-side`, { recursive: true, force: true });
  });

  it('lists the bound doc and the unbound project file, and nothing git ignores', async () => {
    const lib = await items();
    expect(lib.project?.name).toBeTruthy();
    const byName = new Map(lib.files.map((f) => [f.name, f]));
    expect(byName.get('Volunteer handbook')?.href).toMatch(/^\/workspaces\/[^/]+\/docs\//);
    expect(byName.get('tide-gauge.md')?.open).toBe('docs/tide-gauge.md');
    expect(lib.files.some((f) => f.name.includes('hidden'))).toBe(false);
  });

  it('lists a discussion huddle under meetings', async () => {
    const huddle = await at(`/workspaces/${WS}/huddles`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'discussion' }),
    });
    expect(huddle.status).toBe(200);
    const lib = await items();
    expect(lib.meetings).toHaveLength(1);
  });

  it('opens a listed file into a doc on this board, once', async () => {
    const first = await open('docs/tide-gauge.md');
    expect(first.status).toBe(200);
    const { docId, href } = (await first.json()) as { docId: string; href: string };
    expect(href).toBe(`/workspaces/${WS}/docs/${docId}`);
    // The page it names answers, so the tap lands on a doc rather than a 404.
    const page = await at(`/workspaces/${WS}/docs/${encodeURIComponent(docId)}?format=json`);
    expect(page.status).toBe(200);
    // Now it is the board's doc: listed once, as a doc, and a second open
    // of the same path is refused rather than minting a twin.
    const lib = await items();
    const rows = lib.files.filter((f) => f.href === href || f.open === 'docs/tide-gauge.md');
    expect(rows).toEqual([expect.objectContaining({ href })]);
    expect((await open('docs/tide-gauge.md')).status).toBe(404);
  });

  it('opens a mounted file from the checkout its mount recorded', async () => {
    // A second working copy of the same project, holding a file the main
    // checkout does not have. Only the mount lists it, so only the mount
    // knows which bytes the path means.
    const side = `${repo}-side`;
    git(repo, 'worktree', 'add', '-q', side, '-b', 'side');
    mkdirSync(join(side, 'notes'));
    writeFileSync(join(side, 'notes', 'survey.md'), '# Saltmarsh survey\n\nSide-checkout copy.\n');
    const mounted = await at('/api/mounts', {
      method: 'POST',
      body: JSON.stringify({ path: join(side, 'notes') }),
    });
    expect(mounted.status).toBe(200);

    const lib = await items();
    expect(lib.files.some((f) => f.open === 'notes/survey.md')).toBe(true);
    // Positive control on the same server: the main checkout's own file opens.
    expect((await open('docs/tide-gauge.md')).status).toBe(200);

    const res = await open('notes/survey.md');
    expect(res.status).toBe(200);
    const { docId } = (await res.json()) as { docId: string };
    const page = await at(`/workspaces/${WS}/docs/${encodeURIComponent(docId)}?format=json`);
    expect(page.status).toBe(200);
    const doc = (await page.json()) as { meta: { sourceUrl?: string } };
    // The bytes bound are the side checkout's. Joining the path to the MAIN
    // checkout instead would bind a file that is not there at all.
    expect(doc.meta.sourceUrl).toBe(realpathSync(join(side, 'notes', 'survey.md')));
    expect(readFileSync(join(side, 'notes', 'survey.md'), 'utf8')).toContain('Side-checkout copy.');
  });

  it('refuses a path the listing does not offer', async () => {
    // Positive control on the same server: a listed path opens.
    expect((await open('docs/tide-gauge.md')).status).toBe(200);
    expect((await open('private/hidden.md')).status).toBe(404);
    expect((await open('../outside.md')).status).toBe(404);
    expect((await open('handbook.md')).status).toBe(404);
    expect((await open('')).status).toBe(400);
  });
});
