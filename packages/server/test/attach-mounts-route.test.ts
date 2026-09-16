/**
 * What a session attaching to a board is told about mounted folders.
 *
 * Two boards on one real server: one whose project serves a folder, one with
 * no project at all. Both attach over the real route, and the field is read
 * off the attach response — not off the mount table, which is the thing the
 * session cannot see and the reason the field exists.
 *
 * The wording itself is `attach-mounts.ts` and pure; what only a route can
 * prove is that the brief reaches an attaching session at all, that it names
 * the folders the project actually serves, and that a board with nothing
 * mounted is told what mounting would do rather than told nothing.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

interface AttachBody {
  mounts?: { project: string | null; count: number; folders?: string[]; note: string };
  attachment?: { agentId?: string };
}

function git(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

describe('attach_agent says what the board has mounted', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let repo: string;
  /** The board whose docs sit in the repo below. */
  let mounted = '';
  /** A board with no project, and so nothing to mount. */
  let bare = '';

  const at = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${handle.port}${path}`, {
      ...init,
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
    });

  const attach = async (ws: string, agentId: string): Promise<AttachBody> => {
    const res = await at(`/workspaces/${ws}/agents`, {
      method: 'POST',
      body: JSON.stringify({ agentId, runtime: 'claude-code-local' }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as AttachBody;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'attach-mounts-data-'));
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'attach-mounts-repo-')));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'handbook.md'), '# Volunteer handbook\n');
    mkdirSync(join(repo, 'docs', 'mocks'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'mocks', 'home.png'), 'round-one-bytes');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    handle = createServer({ port: 0, dataDir, requireSignInToWrite: false });
    mounted = await seedBoard(`http://127.0.0.1:${handle.port}`, { name: 'Harborlight' });
    bare = await seedBoard(`http://127.0.0.1:${handle.port}`, { name: 'Saltmarsh' });
    // The board's project is the repo most of its own docs sit in, so the
    // board needs a doc in the repo before it has a project at all.
    const bound = await at(`/workspaces/${mounted}/docs`, {
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
  });

  it('names the folders a project serves, and says what a mount is', async () => {
    const res = await at('/api/mounts', {
      method: 'POST',
      body: JSON.stringify({ path: join(repo, 'docs', 'mocks') }),
    });
    expect(res.status).toBe(200);

    const body = await attach(mounted, 'agent:reader');
    // Positive control: a real attach, so an assertion about one of its
    // fields is an assertion about a response that happened.
    expect(body.attachment?.agentId).toBe('agent:reader');
    expect(body.mounts?.count).toBe(1);
    expect(body.mounts?.folders).toEqual(['docs/mocks']);
    expect(body.mounts?.project).toBeTruthy();
    expect(body.mounts?.note).toContain('docs/mocks');
    expect(body.mounts?.note).toContain('.gitignore is not a privacy control');
  });

  it('tells a board with nothing mounted what mount_folder would do', async () => {
    const body = await attach(bare, 'agent:newcomer');
    expect(body.attachment?.agentId).toBe('agent:newcomer');
    expect(body.mounts?.count).toBe(0);
    // Not an empty folder list dressed up as an answer: the sentence has to
    // name the verb, or a session that does not know mounts exist cannot ask.
    expect(body.mounts?.note).toContain('mount_folder');
    expect(body.mounts?.note).toContain('.gitignore is not a privacy control');
  });

  it('says nothing is mounted while the project serves no folder', async () => {
    // The same board as the first case, before the mount: what distinguishes
    // the two answers is the mount table, not which board asked.
    const body = await attach(mounted, 'agent:early');
    expect(body.mounts?.count).toBe(0);
    expect(body.mounts?.note).toContain('mount_folder');
  });
});
