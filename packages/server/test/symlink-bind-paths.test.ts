/**
 * A bind must not copy a symlink's target into a doc unless the folder lists
 * that target.
 *
 * #1326 judged a symlink by the file it lands on for the request paths (raw,
 * context-file, editable-file, the member link). Two paths bound before any
 * request: a browse bind's entry doc, and every changed file of a
 * working-tree diff. Both read through the link, so `README.md -> .env` with
 * `.env` gitignored, or a link to a file outside the root, put the target's
 * bytes in the `.ydoc`, and every share visitor on the board could read them
 * (security review, 2026-10-19, M1).
 *
 * Driven through the real routes, as the local owner and as a share visitor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memberDocId } from '../src/bind-meta.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';

const FAKE = 'HARBORLIGHT_FAKE=1';
const OUTSIDE = 'RIVERBEND_OUTSIDE=1';

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

function commitAll(repo: string, message: string): void {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
}

interface Bound {
  setId: string;
  skipped: Array<{ path: string; reason: string }>;
  files: Array<{ relPath: string; docId: string }>;
  listed?: string[];
}

describe('a bind does not read through a symlink to a file the folder hides', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let outside: string;
  let base: string;
  let boardId = '';
  let visitorHeaders: Record<string, string>;
  let access: AccessHarness;
  const dirs: string[] = [];

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
    });
  const visitor = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { ...visitorHeaders, 'content-type': 'application/json' },
    });
  const callers = { owner: local, visitor } as const;
  const content = (as: typeof local, docId: string) =>
    as(`/workspaces/${boardId}/docs/${encodeURIComponent(docId)}/content`);

  function newRepo(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `symbind-${prefix}-`));
    dirs.push(dir);
    git(dir, 'init', '-q');
    return dir;
  }

  async function browse(repo: string): Promise<Bound> {
    const res = await local('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ folderPath: repo, hubWorkspaceId: boardId }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Bound;
  }

  async function diff(repo: string, baseRef: string): Promise<Bound> {
    const res = await local(`/workspaces/${boardId}/attachments`, {
      method: 'POST',
      body: JSON.stringify({ repo, base: baseRef }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Bound;
  }

  /** Neither caller reads either secret through `docId`. */
  async function expectNoBytes(docId: string): Promise<void> {
    for (const as of Object.values(callers)) {
      const text = await content(as, docId).then((r) => r.text());
      expect(text).not.toContain(FAKE);
      expect(text).not.toContain(OUTSIDE);
    }
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'symbind-data-'));
    outside = mkdtempSync(join(tmpdir(), 'symbind-out-'));
    dirs.push(dataDir, outside);
    writeFileSync(join(outside, 'secret.md'), `${OUTSIDE}\n`);

    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;
    const board = await local('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Harborlight board' }),
    }).then((r) => r.json());
    boardId = board.workspace.id as string;
    visitorHeaders = (await mintAccessShare(base, access, boardId)).headers;
  });

  afterAll(async () => {
    await handle.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  describe('a browse bind entry', () => {
    it('skips README.md -> .env (gitignored) and opens the next eligible file', async () => {
      const repo = newRepo('env');
      writeFileSync(join(repo, '.gitignore'), '.env\n');
      writeFileSync(join(repo, '.env'), `${FAKE}\n`);
      writeFileSync(join(repo, 'guide.md'), '# Guide\n\nsaltmarsh guide body\n');
      symlinkSync('.env', join(repo, 'README.md'));
      commitAll(repo, 'fixture');

      for (const round of ['first bind', 're-bind']) {
        const bound = await browse(repo);
        await expectNoBytes(memberDocId(bound.setId, 'README.md'));
        expect({ round, skipped: bound.skipped }).toMatchObject({
          round,
          skipped: expect.arrayContaining([{ path: 'README.md', reason: 'symlink-target' }]),
        });
        expect(bound.files.map((f) => f.relPath)).toEqual(['guide.md']);
        expect(bound.listed).not.toContain('README.md');
        for (const as of Object.values(callers)) {
          const res = await content(as, memberDocId(bound.setId, 'guide.md'));
          expect(res.status).toBe(200);
          expect(await res.text()).toContain('saltmarsh guide body');
        }
      }
    }, 60_000);

    it('skips an entry that points outside the root', async () => {
      const repo = newRepo('out');
      writeFileSync(join(repo, 'other.md'), '# Other\n');
      symlinkSync(join(outside, 'secret.md'), join(repo, 'README.md'));
      commitAll(repo, 'fixture');

      const bound = await browse(repo);
      await expectNoBytes(memberDocId(bound.setId, 'README.md'));
      expect(bound.skipped).toContainEqual({ path: 'README.md', reason: 'symlink-target' });
      expect(bound.files.map((f) => f.relPath)).toEqual(['other.md']);
    }, 60_000);

    it('opens an entry that links to a listed file (control)', async () => {
      const repo = newRepo('listed');
      writeFileSync(join(repo, 'guide.md'), '# Guide\n\nharborlight linked body\n');
      symlinkSync('guide.md', join(repo, 'README.md'));
      commitAll(repo, 'fixture');

      const bound = await browse(repo);
      expect(bound.skipped.map((s) => s.path)).not.toContain('README.md');
      expect(bound.files.map((f) => f.relPath)).toEqual(['README.md']);
      for (const as of Object.values(callers)) {
        const res = await content(as, memberDocId(bound.setId, 'README.md'));
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('harborlight linked body');
      }
    }, 60_000);
  });

  describe('a working-tree diff', () => {
    it('skips a changed link to .env and one to an outside file, and keeps a link to a listed file', async () => {
      const repo = newRepo('diff');
      writeFileSync(join(repo, '.gitignore'), '.env\n');
      writeFileSync(join(repo, '.env'), `${FAKE}\n`);
      writeFileSync(join(repo, 'a.md'), '# A\n\nriverbend a body\n');
      commitAll(repo, 'base');
      symlinkSync('.env', join(repo, 'notes.md'));
      symlinkSync(join(outside, 'secret.md'), join(repo, 'far.md'));
      symlinkSync('a.md', join(repo, 'alias.md'));
      commitAll(repo, 'links');

      const bound = await diff(repo, 'HEAD~1');
      for (const rel of ['notes.md', 'far.md']) {
        await expectNoBytes(memberDocId(bound.setId, rel));
      }
      const skipped = [...bound.skipped].sort((x, y) => x.path.localeCompare(y.path));
      expect(skipped).toEqual([
        { path: 'far.md', reason: 'symlink-target' },
        { path: 'notes.md', reason: 'symlink-target' },
      ]);
      expect(bound.files.map((f) => f.relPath)).toEqual(['alias.md']);
      for (const as of Object.values(callers)) {
        const res = await content(as, memberDocId(bound.setId, 'alias.md'));
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('riverbend a body');
      }
    }, 60_000);
  });
});
