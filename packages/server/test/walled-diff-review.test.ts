/**
 * A walled lead's `create_diff_review` on its own repository, over its
 * board's socket: the base resolves, the changed files are listed and each
 * file's base text is served, all through contained git
 * (`git-contained.ts`). Before this, every step ran sync git, which answers
 * "barred" for any repository under a root, so the bind failed `bad-ref`.
 * The control: the same session is refused another board's root. macOS
 * only (contained git needs `sandbox-exec`). Fixtures synthetic, temp dirs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSocketPath } from '../src/board-sockets.ts';
import { refuseLeadDiff } from '../src/routes/lead-diff-scope.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { treeFsMode } from '../src/tree-fs.ts';

const CONTAINED = treeFsMode() === 'contained';
const json = { 'content-type': 'application/json' };
const gitEnv = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8' });

/** A repository on `main` with one commit, then one file changed in the tree. */
function repo(dir: string): void {
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'plan.md'), '# plan\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=Alice', '-c', 'user.email=alice@example.invalid', 'commit', '-qm', 's');
  writeFileSync(join(dir, 'docs', 'plan.md'), '# plan\n\nA second line.\n');
}

describe.skipIf(!CONTAINED)('a walled lead’s diff review of its own repository', () => {
  let h: ServerHandle;
  let dataDir: string;
  let workDir: string;
  let socketRoot: string;
  let base: string;
  let harborlight: string;
  let riverbend: string;
  let ownRoot: string;
  let otherRoot: string;
  const tcp = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { ...json, ...(init.headers ?? {}) } });
  const onSocket = (path: string, init: RequestInit = {}) =>
    fetch(`http://board${path}`, {
      ...init,
      unix: boardSocketPath(join(socketRoot, 'boards'), harborlight),
      headers: { ...json, ...(init.headers ?? {}) },
    } as RequestInit);
  const board = async (name: string) =>
    (
      (await (
        await tcp('/workspaces', { method: 'POST', body: JSON.stringify({ name }) })
      ).json()) as { workspace: { id: string } }
    ).workspace.id;
  const setRoots = async (id: string, roots: string[]) =>
    expect(
      (
        await tcp(`/api/board-sockets/${id}/roots`, {
          method: 'PUT',
          body: JSON.stringify({ roots }),
        })
      ).status,
    ).toBe(200);

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'walled-diff-'));
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'walled-diff-work-')));
    socketRoot = mkdtempSync('/private/tmp/wdr-');
    h = createServer({ port: 0, dataDir, boardSocketDir: join(socketRoot, 'boards') });
    base = `http://127.0.0.1:${h.port}`;
    harborlight = await board('Harborlight');
    riverbend = await board('Riverbend');
    ownRoot = join(workDir, 'harbor-project');
    otherRoot = join(workDir, 'riverbend-project');
    repo(ownRoot);
    repo(otherRoot);
    await setRoots(harborlight, [ownRoot]);
    await setRoots(riverbend, [otherRoot]);
  });

  afterAll(async () => {
    await h.stop();
    for (const d of [dataDir, workDir, socketRoot]) rmSync(d, { recursive: true, force: true });
  });

  it('resolves its base, lists the changed file and serves its base text', async () => {
    const r = await onSocket(`/workspaces/${harborlight}/attachments`, {
      method: 'POST',
      body: JSON.stringify({ repo: ownRoot, base: 'main' }),
    });
    const body = await r.text();
    expect(r.status, body).toBe(200);
    const got = JSON.parse(body) as { files: Array<{ docId: string; relPath: string }> };
    const plan = got.files.find((f) => f.relPath === 'docs/plan.md');
    expect(plan).toBeDefined();
    const diff = await onSocket(`/workspaces/${harborlight}/docs/${plan?.docId}/diff`);
    expect(diff.status).toBe(200);
    expect(((await diff.json()) as { baseText: string | null }).baseText).toBe('# plan\n');
  });

  it('is refused another board’s root (the control)', async () => {
    for (const ws of [harborlight, riverbend]) {
      const r = await onSocket(`/workspaces/${ws}/attachments`, {
        method: 'POST',
        body: JSON.stringify({ repo: otherRoot, base: 'main' }),
      });
      expect(r.status).not.toBe(200);
      expect(await r.text()).not.toContain('docs/plan.md');
    }
  });
});

describe('refuseLeadDiff', () => {
  const inRoot = (_board: string, repo: string) => (repo.startsWith('/r/') ? repo : null);
  it.skipIf(!CONTAINED)('passes a repo inside the board’s root, and refuses the rest', () => {
    expect(refuseLeadDiff('w-a', { repo: '/r/x', base: 'main' }, inRoot)).toEqual({ repo: '/r/x' });
    for (const body of [
      { repo: '/elsewhere', base: 'main' },
      { repo: '/r/x' },
      { repo: '/r/x', base: 'main', reviewId: 'd-other' },
      { repo: '/r/x', base: 'main', maxFiles: 10_000 },
    ])
      expect(refuseLeadDiff('w-a', body, inRoot)).toMatchObject({ error: 'out_of_lead_scope' });
  });
});
