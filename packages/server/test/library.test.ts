/**
 * The board's Library, built: which docs are meetings and which are files,
 * and which project files it offers beyond the board's own docs. Driven over
 * hand-built sources, so every rule here is read off the payload rather than
 * off a server.
 *
 * The same rules over the real routes and a real git repo are
 * `library-routes.test.ts` beside this.
 *
 * All fixtures synthetic.
 */
import { describe, expect, it } from 'bun:test';
import type { DocMeta } from '@claude-workspaces/core';
import { makeDocKey } from '../src/doc-key.ts';
import {
  type LibrarySources,
  abbreviateHome,
  buildLibrary,
  displayNames,
  openableFiles,
} from '../src/library.ts';

const REPO = 'git:example.com/harborlight/riverbend';

function meta(docId: string, extra: Partial<DocMeta> = {}): DocMeta {
  return { docId, type: 'markdown', createdAt: 1_000, ...extra };
}

function sources(over: Partial<LibrarySources> = {}): LibrarySources {
  return {
    workspaceId: 'w-test',
    docs: [],
    docKeyOf: () => undefined,
    lastMeeting: () => undefined,
    fileMtime: () => undefined,
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
        lastMeeting: (id) =>
          id === 'd-sync' ? { startedAt: 9_000, endedAt: 9_000 + 47 * 60_000 } : undefined,
        fileMtime: (id) => (id === 'd-note' ? 5_000 : 2_000),
      }),
    );
    expect(lib.meetings.map((r) => [r.name, r.at])).toEqual([
      ['Harborlight weekly sync', 9_000],
      ['Trail map review', 1_000],
    ]);
    expect(lib.files.map((r) => r.name)).toEqual(['Volunteer handbook', 'Saltmarsh plan']);
    expect(lib.meetings[0]?.href).toBe('/workspaces/w-test/docs/d-sync');
  });

  /**
   * Finding 3 of the Library fresh-eyes pass. Every meeting is titled from
   * the clock at the minute it opened, so two in one minute read the same
   * — the row has to carry what separates them.
   */
  it('gives a meeting row its length, so two of one title are told apart', () => {
    const both = [
      meta('d-am', { title: 'Meeting notes 2026-09-11 16:11' }),
      meta('d-pm', { title: 'Meeting notes 2026-09-11 16:11' }),
    ];
    const held: Record<string, { startedAt: number; endedAt: number | null }> = {
      'd-am': { startedAt: 9_000, endedAt: 9_000 + 47 * 60_000 },
      // Still running: no end, so no length to claim.
      'd-pm': { startedAt: 90_000, endedAt: null },
    };
    const lib = buildLibrary(sources({ docs: both, lastMeeting: (id) => held[id] }));
    expect(lib.meetings.map((r) => [r.at, r.durationMs])).toEqual([
      [90_000, undefined],
      [9_000, 47 * 60_000],
    ]);
  });

  /**
   * Finding 2. Binding is what gives a doc a title, so a row that switched to
   * it read as though the file had been renamed the moment somebody opened
   * it — with the naming pass run per-list, the label could change shape too.
   */
  it('keeps a file row named by its file after a doc with a title holds it', () => {
    const listing = sources({
      markdownFiles: () => [
        { relPath: 'docs/README.md', mtimeMs: 4_000 },
        { relPath: 'client/README.md', mtimeMs: 5_000 },
      ],
      docKeyOf: (id) => (id === 'd-plan' ? makeDocKey(REPO, 'docs/plan.md') : undefined),
      docs: [meta('d-plan', { title: 'Riverbend project plan' })],
    });
    const before = buildLibrary(listing);
    expect(before.files.map((r) => r.name)).toEqual([
      'client/README.md',
      'docs/README.md',
      'plan.md',
    ]);

    // The same repo, with `docs/README.md` now a doc of this board carrying a
    // title an agent gave it.
    const keys: Record<string, string> = {
      'd-plan': makeDocKey(REPO, 'docs/plan.md'),
      'd-readme': makeDocKey(REPO, 'docs/README.md'),
    };
    const after = buildLibrary(
      sources({
        markdownFiles: listing.markdownFiles,
        docKeyOf: (id) => keys[id],
        fileMtime: (id) => (id === 'd-readme' ? 4_000 : undefined),
        docs: [
          meta('d-plan', { title: 'Riverbend project plan' }),
          meta('d-readme', { title: 'How the client boots' }),
        ],
      }),
    );
    expect(after.files.map((r) => r.name)).toEqual([
      'client/README.md',
      'docs/README.md',
      'plan.md',
    ]);
  });

  /**
   * Finding 1. `lastActivityAt` moves for a comment and stands still for a
   * `git pull`; an unopened file's row is its mtime. One column, two
   * measurements — so a bound doc's row reads from the file as well.
   */
  it('times every file row by its file on disk, never the doc activity', () => {
    const lib = buildLibrary(
      sources({
        docs: [
          meta('d-note', { title: 'Volunteer handbook', lastActivityAt: 9_999_999 }),
          meta('d-gone', { title: 'A doc whose file went away', lastActivityAt: 8_888_888 }),
        ],
        docKeyOf: (id) => (id === 'd-note' ? makeDocKey(REPO, 'handbook.md') : undefined),
        fileMtime: (id) => (id === 'd-note' ? 4_000 : undefined),
        markdownFiles: () => [
          { relPath: 'handbook.md', mtimeMs: 4_000 },
          { relPath: 'README.md', mtimeMs: 6_000 },
        ],
      }),
    );
    expect(lib.files.map((r) => [r.name, r.at])).toEqual([
      ['README.md', 6_000],
      ['handbook.md', 4_000],
      // No clock reading at all rather than a substitute — and last, because
      // unknown is not "oldest".
      ['A doc whose file went away', undefined],
    ]);
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
        fileMtime: (id) => (id === 'd-plan' ? 2_000 : undefined),
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
      // The bound doc is its FILE here — same name it had before anybody
      // opened it, same clock as the rows around it.
      { name: 'plan.md', at: 2_000, href: '/workspaces/w-test/docs/d-plan' },
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
