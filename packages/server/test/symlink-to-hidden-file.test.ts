/**
 * A symlink inside an attached folder must not serve a file the folder hides.
 *
 * `git ls-files` lists a symlink under its own name, and the tree gate, the
 * exclude and the credential floor all used to judge only that name. So
 * `clip.mp4 -> .env`, with `.env` gitignored, was listed, stayed inside the
 * root, and the raw route streamed `.env`'s bytes; `notes.md -> .env` did the
 * same through `context-file` and the member link. The rule now: a symlink
 * is judged by the file it lands on, and that file must itself be listed.
 *
 * Driven through the real routes, as the local owner and as a share visitor.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memberDocId } from '../src/bind-meta.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';
import { tinyMp4 } from './tiny-mp4.ts';

const FAKE = 'HARBORLIGHT_FAKE=1';

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

describe('a symlink to a file the folder hides', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  let base: string;
  let boardId = '';
  let setId = '';
  let visitorHeaders: Record<string, string>;
  let access: AccessHarness;
  const video = tinyMp4(800, 5);

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const visitor = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        ...visitorHeaders,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const callers = { owner: local, visitor } as const;
  type Caller = (path: string, init?: RequestInit) => Promise<Response>;

  const raw = (as: Caller, rel: string) =>
    as(`/workspaces/${boardId}/attachments/${setId}/raw?path=${encodeURIComponent(rel)}`);
  const contextFile = (as: Caller, relPath: string) =>
    as(`/workspaces/${boardId}/attachments/${setId}/context-file`, {
      method: 'POST',
      body: JSON.stringify({ relPath }),
    });
  const editableFile = (as: Caller, relPath: string) =>
    as(`/workspaces/${boardId}/attachments/${setId}/editable-file`, {
      method: 'POST',
      body: JSON.stringify({ relPath }),
    });
  const content = (as: Caller, docId: string) =>
    as(`/workspaces/${boardId}/docs/${encodeURIComponent(docId)}/content`);

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'symhide-data-'));
    repo = mkdtempSync(join(tmpdir(), 'symhide-repo-'));

    writeFileSync(join(repo, 'README.md'), '# Harborlight\n\nentry\n');
    writeFileSync(join(repo, '.gitignore'), '.env\n');
    writeFileSync(join(repo, '.env'), `${FAKE}\n`);
    writeFileSync(join(repo, 'guide.md'), '# Guide\n\nriverbend guide body\n');
    writeFileSync(join(repo, 'real.mp4'), video);
    // Committed but never listed: the credential floor drops the name.
    writeFileSync(join(repo, 'server.pem'), `${FAKE}\n`);
    // Listed, but kept out of the set by its exclude.
    mkdirSync(join(repo, 'private'));
    writeFileSync(join(repo, 'private', 'plan.md'), `${FAKE}\n`);
    // Relative targets, the way a repo carries them.
    symlinkSync('.env', join(repo, 'clip.mp4'));
    symlinkSync('.env', join(repo, 'notes.md'));
    symlinkSync('server.pem', join(repo, 'cert.md'));
    symlinkSync('private/plan.md', join(repo, 'peek.md'));
    // Controls: a symlink to a file the folder does list.
    symlinkSync('real.mp4', join(repo, 'alias.mp4'));
    symlinkSync('guide.md', join(repo, 'guide-link.md'));
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture');

    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://127.0.0.1:${handle.port}`;

    const board = await local('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Harborlight board' }),
    }).then((r) => r.json());
    boardId = board.workspace.id as string;
    const bound = await local('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ folderPath: repo, hubWorkspaceId: boardId, exclude: ['private'] }),
    }).then((r) => r.json());
    setId = bound.workspaceId as string;
    expect(setId).toBeTruthy();

    visitorHeaders = (
      await mintAccessShare(base, { ...access, shareLinks: handle.shareLinks }, boardId)
    ).headers;
  });

  afterAll(async () => {
    await handle.stop();
    for (const d of [dataDir, repo]) rmSync(d, { recursive: true, force: true });
  });

  for (const [who, as] of Object.entries(callers)) {
    describe(`as the ${who}`, () => {
      it('streams a symlink to a listed video (control)', async () => {
        const res = await raw(as, 'alias.mp4');
        expect(res.status).toBe(200);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(video);
      });

      it('opens a symlink to a listed doc (control)', async () => {
        const res = await contextFile(as, 'guide-link.md');
        expect(res.status).toBe(200);
        const { docId } = (await res.json()) as { docId: string };
        const doc = (await content(as, docId).then((r) => r.json())) as { plainText: string };
        expect(doc.plainText).toContain('riverbend guide body');
      });

      it('refuses the raw route for a video named symlink to a gitignored file', async () => {
        const res = await raw(as, 'clip.mp4');
        expect(await res.text()).not.toContain(FAKE);
        expect(res.status).toBe(404);
      });

      for (const rel of ['notes.md', 'cert.md', 'peek.md']) {
        it(`refuses context-file and editable-file for ${rel}`, async () => {
          for (const open of [contextFile, editableFile]) {
            const res = await open(as, rel);
            const body = await res.text();
            expect(body).not.toContain(FAKE);
            expect(res.status).toBe(404);
            expect((JSON.parse(body) as { error: string }).error).toBe('not-listed');
          }
        });
      }

      it('opens nothing through the member link of a symlink to a hidden file', async () => {
        for (const rel of ['notes.md', 'cert.md', 'peek.md']) {
          const res = await content(as, memberDocId(setId, rel));
          expect(await res.text()).not.toContain(FAKE);
          expect(res.status).not.toBe(200);
        }
      });
    });
  }
});
