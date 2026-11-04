/**
 * The git proxy's worktree maker (`git-proxy-worktree.ts`), with real git
 * on throwaway repos and no sandbox: what it makes, what it refuses, and
 * that it runs no hook. The walled lead driving it through the proxy is
 * `lead-sandbox-ship.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProxyLead } from './git-proxy-lead.ts';
import { createGitProxy } from './git-proxy-server.ts';
import { WORKTREE_PATH, addLeadWorktree, parseWorktreeForm } from './git-proxy-worktree.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-proxy-worktree-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Alice',
  GIT_AUTHOR_EMAIL: 'alice@example.invalid',
  GIT_COMMITTER_NAME: 'Alice',
  GIT_COMMITTER_EMAIL: 'alice@example.invalid',
};
const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });

/** A repo with one commit on main, inside `project`. */
function repo(project: string): string {
  mkdirSync(project, { recursive: true });
  expect(git(project, ['init', '-q', '-b', 'main']).status).toBe(0);
  expect(git(project, ['commit', '-q', '--allow-empty', '-m', 'first']).status).toBe(0);
  return project;
}

const ask = (repoPath: string, name: string, branch = name, base = 'main') => ({
  repo: repoPath,
  name,
  branch,
  base,
});

describe('parseWorktreeForm', () => {
  it('reads a form, with branch defaulting to the name and base to origin/HEAD', () => {
    expect(parseWorktreeForm('repo=%2Fp%2Fr&name=fix-1')).toEqual({
      repo: '/p/r',
      name: 'fix-1',
      branch: 'fix-1',
      base: 'origin/HEAD',
    });
  });

  it('refuses a relative repo, a name with a slash or a dot step, and an option for a ref', () => {
    expect(parseWorktreeForm('repo=p&name=a')).toContain('absolute');
    for (const name of ['a/b', '..', '-x', 'a.lock', ''])
      expect(parseWorktreeForm(`repo=/p&name=${encodeURIComponent(name)}`)).toContain('name');
    for (const branch of ['-f', 'a..b', 'a/', 'a b', 'x@{1}'])
      expect(parseWorktreeForm(`repo=/p&name=a&branch=${encodeURIComponent(branch)}`)).toContain(
        'branch',
      );
    expect(parseWorktreeForm('repo=/p&name=a&base=--orphan')).toContain('base');
  });
});

describe('addLeadWorktree', () => {
  it('makes the fixed shape, set to push to origin/<branch>, and runs no hook', () => {
    const p = repo(join(root, 'harborlight'));
    expect(git(p, ['remote', 'add', 'origin', 'https://github.com/Harborlight/notes']).status).toBe(
      0,
    );
    // An owner's hook that would leave a mark if the proxy's git ran it.
    const mark = join(root, 'hook-ran');
    writeFileSync(join(p, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch '${mark}'\n`, {
      mode: 0o755,
    });
    const made = addLeadWorktree([p], ask(p, 'fix-1', 'fix/one'));
    expect(made).toEqual({
      ok: true,
      path: join(p, '.claude', 'worktrees', 'fix-1'),
      branch: 'fix/one',
    });
    const wt = join(p, '.claude', 'worktrees', 'fix-1');
    expect(readFileSync(join(wt, '.git'), 'utf8').trim()).toBe(
      `gitdir: ${join(p, '.git', 'worktrees', 'fix-1')}`,
    );
    expect(git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()).toBe('fix/one');
    expect(git(p, ['config', 'branch.fix/one.remote']).stdout.trim()).toBe('origin');
    expect(git(p, ['config', 'branch.fix/one.merge']).stdout.trim()).toBe('refs/heads/fix/one');
    expect(existsSync(mark)).toBe(false);
    // The control: the same hook does run for the owner's own git.
    expect(git(p, ['worktree', 'add', '-q', join(root, 'ctl'), '-b', 'ctl']).status).toBe(0);
    expect(existsSync(mark)).toBe(true);
  });

  it("refuses a repo outside the lead's projects", () => {
    const mine = repo(join(root, 'mine'));
    const theirs = repo(join(root, 'riverbend'));
    const made = addLeadWorktree([mine], ask(theirs, 'x'));
    expect(made).toMatchObject({ ok: false, status: 403 });
    expect(existsSync(join(theirs, '.claude'))).toBe(false);
  });

  it('accepts a repo inside a project, and refuses one reached through a symlink out of it', () => {
    const project = join(root, 'saltmarsh');
    const inner = repo(join(project, 'app'));
    expect(addLeadWorktree([project], ask(inner, 'w'))).toMatchObject({ ok: true });
    const outside = repo(join(root, 'outside'));
    symlinkSync(outside, join(project, 'link'));
    expect(addLeadWorktree([project], ask(join(project, 'link'), 'w'))).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it('refuses when .claude is a symlink, so nothing is written where it points', () => {
    const p = repo(join(root, 'linked'));
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(p, '.claude'));
    expect(addLeadWorktree([p], ask(p, 'w'))).toMatchObject({ ok: false, status: 400 });
    expect(existsSync(join(elsewhere, 'worktrees'))).toBe(false);
  });

  it('refuses a worktree or branch that exists, and a .git that is a file', () => {
    const p = repo(join(root, 'twice'));
    expect(addLeadWorktree([p], ask(p, 'w'))).toMatchObject({ ok: true });
    expect(addLeadWorktree([p], ask(p, 'w'))).toMatchObject({ ok: false, status: 409 });
    expect(addLeadWorktree([p], ask(p, 'w2', 'w'))).toMatchObject({ ok: false, status: 409 });
    const wt = join(p, '.claude', 'worktrees', 'w');
    expect(addLeadWorktree([p], ask(wt, 'nested'))).toMatchObject({ ok: false, status: 400 });
  });

  it('says why when git refuses the base', () => {
    const p = repo(join(root, 'nobase'));
    const made = addLeadWorktree([p], ask(p, 'w', 'w', 'origin/HEAD'));
    expect(made).toMatchObject({ ok: false, status: 400 });
    expect(made.ok || made.why).toContain('git worktree add failed');
  });
});

describe('POST /-/worktree on the git proxy', () => {
  const token = 'a'.repeat(43);
  const project = join(root, 'routed');
  let server: http.Server;
  let url = '';
  afterAll(() => new Promise((r) => server?.close(r)));

  const post = async (body: string, auth: string | null = `harbor:${token}`) => {
    if (!server) {
      repo(project);
      const lead: ProxyLead = { name: 'harbor', repos: new Set(), gh: false, projects: [project] };
      server = createGitProxy({
        credential: 'fake-owner-credential',
        upstream: 'http://127.0.0.1:9',
        api: 'http://127.0.0.1:9',
        leads: () => new Map([[token, lead]]),
        log: () => {},
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${WORKTREE_PATH}`;
    }
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (auth) headers.authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
    const res = await fetch(url, { method: 'POST', headers, body });
    return { status: res.status, text: (await res.text()).trim() };
  };
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

  it('answers 401 without a lead token, and makes nothing', async () => {
    expect((await post(form({ repo: project, name: 'w' }), null)).status).toBe(401);
    expect((await post(form({ repo: project, name: 'w' }), 'harbor:wrong')).status).toBe(401);
    expect(existsSync(join(project, '.claude'))).toBe(false);
  });

  it('answers 400 to a bad name and 403 to a repo outside its projects', async () => {
    expect((await post(form({ repo: project, name: '../x' }))).status).toBe(400);
    const other = repo(join(root, 'not-routed'));
    expect((await post(form({ repo: other, name: 'w', base: 'main' }))).status).toBe(403);
  });

  it("makes the worktree for the token's lead and answers its path", async () => {
    const r = await post(form({ repo: project, name: 'w', base: 'main' }));
    expect(r).toEqual({ status: 200, text: join(project, '.claude', 'worktrees', 'w') });
  });
});
