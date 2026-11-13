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
  it('puts a doc that held a meeting, and BOTH huddle kinds, under meetings', () => {
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
    // A plan huddle is a meeting too: "Make a plan" and "have a meeting" are
    // two ways into one conversation, and a person hunting for it presses
    // neither button again — they open the meetings list.
    expect(lib.meetings.map((r) => r.name).sort()).toEqual([
      'Harborlight weekly sync',
      'Saltmarsh plan',
      'Trail map review',
    ]);
    expect(lib.files.map((r) => r.name)).toEqual(['Volunteer handbook']);
    expect(lib.meetings.find((r) => r.name === 'Harborlight weekly sync')?.href).toBe(
      '/workspaces/w-test/docs/d-sync',
    );
  });

  /**
   * Both lists' clock column reads "Last Modified", with "Created" a sort
   * away (Bryan, mock v2). A meeting's last change is its notes' file, then
   * the doc's own activity, and only then when it started; created is when
   * it started.
   */
  it('times a meeting by its last change and dates its creation by its start', () => {
    const lib = buildLibrary(
      sources({
        docs: [
          meta('d-file', { title: 'Ferry schedule sync' }),
          meta('d-active', { title: 'Dock survey sync', lastActivityAt: 70_000 }),
          meta('d-bare', { title: 'Tide gauge sync' }),
        ],
        lastMeeting: (id) => ({ startedAt: id === 'd-bare' ? 30_000 : 10_000, endedAt: null }),
        fileMtime: (id) => (id === 'd-file' ? 90_000 : undefined),
      }),
    );
    expect(lib.meetings.map((r) => [r.name, r.at, r.created])).toEqual([
      ['Ferry schedule sync', 90_000, 10_000],
      ['Dock survey sync', 70_000, 10_000],
      ['Tide gauge sync', 30_000, 30_000],
    ]);
    // No meeting row carries a length any more: the row is a title and a time.
    expect(lib.meetings.every((r) => !('durationMs' in r))).toBe(true);
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
    // `folder` is where each file sits — the page names a burst by it — and a
    // root file's is empty rather than `.`.
    expect(lib.files).toEqual([
      { name: 'site-plan-430.png', at: 6_000, href: '/mounts/f-1/raw', folder: '.workspace' },
      { name: 'guide/README.md', at: 4_000, open: 'docs/guide/README.md', folder: 'docs/guide' },
      // Not `./README.md`: a root file keeps its bare name.
      { name: 'README.md', at: 3_000, open: 'README.md', folder: '' },
      // The bound doc is its FILE here — same name it had before anybody
      // opened it, same clock as the rows around it.
      // It carries its doc id, so the page can file it in a Library folder.
      {
        name: 'plan.md',
        at: 2_000,
        href: '/workspaces/w-test/docs/d-plan',
        folder: 'docs',
        docId: 'd-plan',
      },
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

  it("gives no folder to a doc named by its title rather than its project's file", () => {
    const other = 'git:example.com/harborlight/saltmarsh';
    const keys: Record<string, string> = {
      'd-plan': makeDocKey(REPO, 'docs/plan.md'),
      'd-away': makeDocKey(other, 'private/away.md'),
    };
    const lib = buildLibrary(
      sources({
        docs: [meta('d-plan'), meta('d-away', { title: 'Saltmarsh away note' })],
        docKeyOf: (id) => keys[id],
        fileMtime: (id) => (id === 'd-plan' ? 2_000 : 1_000),
      }),
    );
    // Another repo's path must not arrive through `folder` when the name
    // itself refuses to print it.
    expect(lib.files.map((r) => [r.name, r.folder])).toEqual([
      ['plan.md', 'docs'],
      ['Saltmarsh away note', undefined],
    ]);
  });
});

/**
 * How many labels a Library build joins. Naming is the step that held the
 * event loop for seconds on a board with thousands of rows, and a count of
 * its work says so without reading a clock.
 */
function joinsDuring(build: () => void): number {
  const realJoin = Array.prototype.join;
  let joins = 0;
  Array.prototype.join = function join(this: unknown[], separator?: string): string {
    joins += 1;
    return realJoin.call(this, separator);
  };
  try {
    build();
  } finally {
    Array.prototype.join = realJoin;
  }
  return joins;
}

describe('a Library load over a large project', () => {
  const loadOf = (paths: readonly string[]) =>
    joinsDuring(() =>
      buildLibrary(
        sources({
          docs: [meta('d-plan', { title: 'Plan' })],
          docKeyOf: () => makeDocKey(REPO, 'docs/plan.md'),
          markdownFiles: () => paths.map((relPath, i) => ({ relPath, mtimeMs: i })),
        }),
      ),
    );
  const unique = (n: number) =>
    Array.from({ length: n }, (_, i) => `docs/area-${i % 40}/note-${i}.md`);
  const sameName = (n: number) => Array.from({ length: n }, (_, i) => `area-${i}/docs/README.md`);

  it('names each row a bounded number of times, however many rows there are', () => {
    for (const paths of [unique(400), sameName(400)]) {
      const joins = loadOf(paths);
      // Above zero, or this reads nothing: a build that stopped using join
      // would pass the ceiling having measured no work at all.
      expect(joins).toBeGreaterThanOrEqual(paths.length);
      expect(joins).toBeLessThanOrEqual(paths.length * 4);
    }
  });

  it('does twice the naming for twice the rows', () => {
    expect(loadOf(unique(800))).toBeLessThanOrEqual(loadOf(unique(400)) * 2.5);
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

  it('names a path exactly as a pairwise comparison of every label would', () => {
    // The rule itself, spelled the slow way: grow a path's label until no
    // other path carries the same one, or the path runs out of folders.
    const pairwise = (relPaths: readonly string[]): Map<string, string> => {
      const paths = [...new Set(relPaths)];
      const segs = (rel: string) => rel.split('/').filter((s) => s && s !== '.');
      const label = (rel: string, depth: number) => segs(rel).slice(-depth).join('/');
      const out = new Map<string, string>();
      for (const rel of paths) {
        let depth = 1;
        while (
          depth < segs(rel).length &&
          paths.some((o) => o !== rel && label(o, depth) === label(rel, depth))
        ) {
          depth += 1;
        }
        out.set(rel, label(rel, depth));
      }
      return out;
    };
    const words = ['a', 'b', 'docs', 'README.md', 'plan.md'];
    let seed = 7;
    const pick = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 200; round += 1) {
      const paths = Array.from({ length: 1 + pick(14) }, () =>
        Array.from({ length: 1 + pick(5) }, () => words[pick(words.length)]).join('/'),
      );
      // Spellings a listing should never produce still get one answer.
      paths.push('./a/plan.md', 'a//plan.md', '.', '');
      expect([...displayNames(paths)]).toEqual([...pairwise(paths)]);
    }
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
