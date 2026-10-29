/**
 * The board bundle's own checks (`infra/project-machine/board-bundle.ts`),
 * with no server: which shared-file entries move, and that a bundle not
 * written by `exportBoard` is refused before anything reaches the target.
 * The move between two servers is `project-machine-move-board.test.ts`.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import {
  exportBoard,
  importBoard,
  readBundle,
} from '../../../infra/project-machine/board-bundle.ts';

const scratch = mkdtempSync(join(tmpdir(), 'cw-board-bundle-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('board bundle checks', () => {
  it('refuses a bundle path outside what a board owns', () => {
    const dir = join(scratch, 'evil');
    mkdirSync(join(dir, 'files'), { recursive: true });
    writeFileSync(join(dir, 'files', 'x'), 'x');
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        format: 'cw-board-bundle-1',
        boardId: 'w-Harbor1',
        boardName: 'Harborlight',
        exportedAt: 0,
        docIds: ['ws:w-Harbor1'],
        files: [{ path: '../share-cookie.key', sha256: '', bytes: 1 }],
        merges: {},
        bindings: [],
      }),
    );
    expect(() => readBundle(dir)).toThrow(/escapes/);
  });

  it('merges the board entries of shared files and refuses one already there', () => {
    const from = join(scratch, 'merge-from');
    const to = join(scratch, 'merge-to');
    const board = 'w-Harbor2';
    const other = 'w-River02';
    mkdirSync(join(from, 'workspaces'), { recursive: true });
    mkdirSync(join(to, 'workspaces'), { recursive: true });
    writeFileSync(
      join(from, 'workspaces', `${board}.tasks.json`),
      JSON.stringify({
        workspace: {
          id: board,
          name: 'Harborlight',
          docIds: [],
          goals: [],
          notesHome: { repoRoot: '/repo/harborlight', branch: 'main', dir: 'notes' },
        },
        tasks: [],
      }),
    );
    // A board doc written before private meta left the CRDT still carries a path.
    const legacy = new Y.Doc();
    legacy.getMap('meta').set('sourceUrl', '/repo/harborlight/board.md');
    legacy.getMap('meta').set('title', 'Harborlight');
    writeFileSync(join(from, `ws:${board}.ydoc`), Y.encodeStateAsUpdate(legacy));
    const link = (ws: string) => ({ linkId: `l-${ws}`, workspaceId: ws, redemptions: [] });
    const member = (ws: string) => ({
      workspaceId: ws,
      email: 'alice@example.com',
      addedAt: 1,
      viaLinkId: 'x',
    });
    writeFileSync(
      join(from, 'share-links.json'),
      JSON.stringify({
        links: [link(board), link(other)],
        members: [member(board), member(other)],
        audiences: [],
      }),
    );
    writeFileSync(
      join(from, 'sharing.json'),
      JSON.stringify({ enabled: false, lockedBoards: [board, other] }),
    );
    writeFileSync(
      join(from, 'review-ranks.json'),
      JSON.stringify({
        ranks: {
          [`${board}:t-1`]: { rank: 1, at: 1, by: 'a' },
          [`${other}:t-2`]: { rank: 2, at: 1, by: 'a' },
        },
        personMoves: {},
      }),
    );
    writeFileSync(
      join(to, 'share-links.json'),
      JSON.stringify({ links: [link('w-Salt003')], members: [], audiences: [] }),
    );
    const bundle = join(scratch, 'merge-bundle');
    const m = exportBoard(from, board, bundle);
    expect(Object.keys(m.merges).sort()).toEqual([
      'review-ranks.json',
      'share-links.json',
      'sharing.json',
    ]);
    importBoard(bundle, to);
    // Neither Mac path reached the target.
    const record = readFileSync(join(to, 'workspaces', `${board}.tasks.json`), 'utf8');
    expect(record).not.toContain('/repo/harborlight');
    const moved = new Y.Doc();
    Y.applyUpdate(moved, new Uint8Array(readFileSync(join(to, `ws:${board}.ydoc`))));
    expect(moved.getMap('meta').toJSON()).toEqual({ title: 'Harborlight' });
    const links = JSON.parse(readFileSync(join(to, 'share-links.json'), 'utf8')) as {
      links: { workspaceId: string }[];
      members: { workspaceId: string }[];
    };
    expect(links.links.map((l) => l.workspaceId)).toEqual(['w-Salt003', board]);
    expect(links.members.map((l) => l.workspaceId)).toEqual([board]);
    // A target with no sharing.json reads as sharing on, and still does.
    expect(JSON.parse(readFileSync(join(to, 'sharing.json'), 'utf8'))).toEqual({
      enabled: true,
      lockedBoards: [board],
    });
    const ranks = JSON.parse(readFileSync(join(to, 'review-ranks.json'), 'utf8')) as {
      ranks: Record<string, unknown>;
    };
    expect(Object.keys(ranks.ranks)).toEqual([`${board}:t-1`]);

    // A second target that already holds an entry for the board refuses, writing nothing.
    const clash = join(scratch, 'merge-clash');
    mkdirSync(clash);
    const before = JSON.stringify({ links: [link(board)], members: [], audiences: [] });
    writeFileSync(join(clash, 'share-links.json'), before);
    expect(() => importBoard(bundle, clash)).toThrow(/already holds/);
    expect(readFileSync(join(clash, 'share-links.json'), 'utf8')).toBe(before);
    expect(existsSync(join(clash, 'workspaces', `${board}.tasks.json`))).toBe(false);
  });
});

describe('a bundle that was not written by exportBoard', () => {
  const board = 'w-Harbor3';
  const other = 'w-River03';

  /** A small board exported into a fresh bundle, and a target to import it into. */
  function fresh(name: string): { bundle: string; to: string } {
    const from = join(scratch, `${name}-from`);
    const to = join(scratch, `${name}-to`);
    mkdirSync(join(from, 'workspaces'), { recursive: true });
    mkdirSync(to);
    writeFileSync(
      join(from, 'workspaces', `${board}.tasks.json`),
      JSON.stringify({ workspace: { id: board, name: 'Harborlight', docIds: [] }, tasks: [] }),
    );
    const doc = new Y.Doc();
    doc.getMap('meta').set('title', 'Harborlight');
    writeFileSync(join(from, `ws:${board}.ydoc`), Y.encodeStateAsUpdate(doc));
    writeFileSync(
      join(from, 'share-links.json'),
      JSON.stringify({
        links: [{ linkId: 'l-1', workspaceId: board, redemptions: [] }],
        members: [],
        audiences: [],
      }),
    );
    const bundle = join(scratch, `${name}-bundle`);
    exportBoard(from, board, bundle);
    return { bundle, to };
  }

  const manifestOf = (bundle: string) =>
    JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')) as {
      files: { path: string; sha256: string; bytes: number }[];
      merges: Record<string, unknown>;
    };
  const saveManifest = (bundle: string, m: unknown) =>
    writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(m));

  /** Replaces one bundle file and its hash, as a hand-made bundle would. */
  function replace(bundle: string, path: string, bytes: Uint8Array): void {
    writeFileSync(join(bundle, 'files', path), bytes);
    const m = manifestOf(bundle);
    const f = m.files.find((x) => x.path === path);
    if (!f) throw new Error(`no ${path} in the bundle`);
    f.sha256 = createHash('sha256').update(bytes).digest('hex');
    f.bytes = bytes.length;
    saveManifest(bundle, m);
  }

  it('imports the untouched bundle (the control for the refusals below)', () => {
    const { bundle, to } = fresh('control');
    importBoard(bundle, to);
    expect(existsSync(join(to, 'workspaces', `${board}.tasks.json`))).toBe(true);
  });

  it('refuses a doc that would bind itself to a file on the target', () => {
    const { bundle, to } = fresh('bind');
    const doc = new Y.Doc();
    doc.getMap('meta').set('title', 'Harborlight');
    doc.getMap('meta').set('sourceUrl', '/data/cw/share-cookie.key.md');
    replace(bundle, `ws:${board}.ydoc`, Y.encodeStateAsUpdate(doc));
    expect(() => importBoard(bundle, to)).toThrow(/path on another machine/);
    expect(readdirSync(to)).toEqual([]);
  });

  it('refuses a board record that names a notes home', () => {
    const { bundle, to } = fresh('notes');
    const record = {
      workspace: { id: board, name: 'Harborlight', docIds: [], notesHome: { repoRoot: '/etc' } },
      tasks: [],
    };
    replace(bundle, `workspaces/${board}.tasks.json`, Buffer.from(JSON.stringify(record)));
    expect(() => importBoard(bundle, to)).toThrow(/path on another machine/);
  });

  it('refuses shared-file entries for a board that is not the one moving', () => {
    const cases: [string, unknown][] = [
      [
        'share-links.json',
        {
          links: [{ linkId: 'l-2', workspaceId: other, redemptions: [] }],
          members: [],
          audiences: [],
        },
      ],
      ['shares.json', [{ workspaceId: other }]],
      ['sharing.json', { lockedBoards: [other] }],
      ['review-ranks.json', { ranks: { [`${other}:t-1`]: { rank: 1 } } }],
      ['review-answers.jsonl', [JSON.stringify({ workspaceId: other })]],
      ['dispatch-reports.json', { reports: 'not a list' }],
    ];
    for (const [file, entries] of cases) {
      const { bundle, to } = fresh(`scope-${file}`);
      const m = manifestOf(bundle);
      m.merges[file] = entries;
      saveManifest(bundle, m);
      expect(() => importBoard(bundle, to), file).toThrow(/not only board/);
      expect(readdirSync(to), file).toEqual([]);
    }
  });

  it('refuses a bundle file that is a symlink, or one the manifest does not list', () => {
    const link = fresh('symlink');
    const path = join(link.bundle, 'files', `ws:${board}.ydoc`);
    const real = join(scratch, 'symlink-real.ydoc');
    renameSync(path, real);
    symlinkSync(real, path);
    expect(() => importBoard(link.bundle, link.to)).toThrow(/not a plain file/);

    const root = fresh('symlink-root');
    const realRoot = join(scratch, 'symlink-root-files');
    renameSync(join(root.bundle, 'files'), realRoot);
    symlinkSync(realRoot, join(root.bundle, 'files'));
    expect(() => importBoard(root.bundle, root.to)).toThrow(/not a directory/);

    const extra = fresh('extra');
    writeFileSync(join(extra.bundle, 'files', 'stray.ydoc'), 'x');
    expect(() => importBoard(extra.bundle, extra.to)).toThrow(/does not list/);
  });

  it('refuses a share link whose id is already on the target', () => {
    const { bundle, to } = fresh('link-clash');
    const before = JSON.stringify({
      links: [{ linkId: 'l-1', workspaceId: 'w-Salt004', redemptions: [] }],
      members: [],
      audiences: [],
    });
    writeFileSync(join(to, 'share-links.json'), before);
    expect(() => importBoard(bundle, to)).toThrow(/already has that linkId/);
    expect(readFileSync(join(to, 'share-links.json'), 'utf8')).toBe(before);
  });
});
