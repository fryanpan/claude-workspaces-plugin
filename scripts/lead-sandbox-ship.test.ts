/**
 * A walled lead ships a branch the way the fleet does, under the real
 * sandbox-exec: `cw-worktree` asks the git proxy for a worktree of its
 * project, the lead commits there and pushes through the proxy to a
 * stand-in for GitHub (`git-proxy-test-upstream.ts`), then opens the pull
 * request with the real gh through the gh proxy, against a stand-in for
 * api.github.com. The owner's credential is a random string made here and
 * lives only in this process; the lead's environment carries none, and
 * nothing reaches GitHub.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ghProxySocket } from './gh-proxy-lead.ts';
import { createGhProxy } from './gh-proxy-server.ts';
import {
  ensureGitProxyFiles,
  gitProxyEnv,
  gitProxyLeadDir,
  readLeadTokens,
} from './git-proxy-lead.ts';
import { createGitProxy } from './git-proxy-server.ts';
import { type FakeGithub, startFakeGithub } from './git-proxy-test-upstream.ts';
import { type Machine, SANDBOX_EXEC, buildProfile, parseConfig } from './lead-sandbox-lib.ts';
import { ensureLeadTools } from './lead-sandbox-tools.ts';

const GH = spawnSync('/bin/sh', ['-c', 'command -v gh'], { encoding: 'utf8' }).stdout.trim();
const RUN = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);

/** What the stand-in for api.github.com answers, by gh's operation name. */
function apiAnswer(body: string): unknown {
  if (body.includes('GhProxyNodes')) {
    const ids: string[] = JSON.parse(body).variables?.ids ?? [];
    const names: Record<string, string> = {
      R_harbor: 'Harborlight/notes',
      R_river: 'Riverbend/private',
    };
    return {
      data: {
        nodes: ids.map((id) => ({
          __typename: 'Repository',
          nameWithOwner: names[id] ?? 'Other/x',
        })),
      },
    };
  }
  if (body.includes('RepositoryInfo'))
    return {
      data: {
        repository: {
          id: 'R_harbor',
          name: 'notes',
          owner: { login: 'Harborlight' },
          hasIssuesEnabled: true,
          description: '',
          hasWikiEnabled: false,
          viewerPermission: 'WRITE',
          defaultBranchRef: { name: 'main' },
          parent: null,
          mergeCommitAllowed: true,
          rebaseMergeAllowed: true,
          squashMergeAllowed: true,
        },
      },
    };
  if (body.includes('PullRequestForBranch'))
    return { data: { repository: { pullRequests: { nodes: [] } } } };
  if (body.includes('PullRequestCreate'))
    return {
      data: {
        createPullRequest: {
          pullRequest: { id: 'PR_1', url: 'https://github.com/Harborlight/notes/pull/7' },
        },
      },
    };
  return { data: {} };
}

describe.skipIf(!RUN)('a walled lead ships a branch from inside the wall', () => {
  const credential = `fake-owner-${randomBytes(12).toString('hex')}`;
  const uid = 90_000 + Math.floor(Math.random() * 9_000);
  const ghSocket = ghProxySocket(uid);
  const root = realpathSync(mkdtempSync('/private/tmp/ship-'));
  const home = join(root, 'home');
  const project = join(home, 'dev', 'harborlight');
  const worktree = join(project, '.claude', 'worktrees', 'fix-1');
  const repos = join(root, 'upstream');
  const api: { op: string; authorization: string; body: string }[] = [];
  const logs: string[] = [];
  let github: FakeGithub;
  let gitProxy: http.Server;
  let ghProxy: http.Server;
  let apiServer: http.Server;
  let profile = '';
  let leadEnv: Record<string, string> = {};

  /** Owner-side git, outside the wall, with no user config. */
  const bare = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Alice',
    GIT_AUTHOR_EMAIL: 'alice@example.invalid',
    GIT_COMMITTER_NAME: 'Alice',
    GIT_COMMITTER_EMAIL: 'alice@example.invalid',
  };
  const git = (cwd: string, args: string[]) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', env: bare });
  const upstreamRef = (repo: string, ref: string) =>
    git(root, [
      '--git-dir',
      join(repos, `${repo}.git`),
      'rev-parse',
      '--verify',
      '-q',
      ref,
    ]).stdout.trim();

  /** A shell line inside the lead's wall, without blocking the proxies in this process. */
  const inside = (script: string, cwd = project) =>
    new Promise<{ status: number | null; out: string }>((resolve) => {
      const c = spawn(SANDBOX_EXEC, ['-f', profile, '/bin/sh', '-c', script], {
        cwd,
        env: leadEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      c.stdout.on('data', (d: Buffer) => {
        out += d.toString('utf8');
      });
      c.stderr.on('data', (d: Buffer) => {
        out += d.toString('utf8');
      });
      c.on('close', (status) => resolve({ status, out }));
    });

  beforeAll(async () => {
    // The upstream repos, each seeded with one commit.
    const seed = join(root, 'seed');
    mkdirSync(seed, { recursive: true });
    expect(git(seed, ['init', '-q', '-b', 'main']).status).toBe(0);
    writeFileSync(join(seed, 'README.md'), 'first\n');
    expect(git(seed, ['add', 'README.md']).status).toBe(0);
    expect(git(seed, ['commit', '-q', '-m', 'first']).status).toBe(0);
    for (const repo of ['Harborlight/notes', 'Riverbend/private']) {
      const dir = join(repos, `${repo}.git`);
      mkdirSync(dir, { recursive: true });
      expect(git(dir, ['init', '-q', '--bare', '-b', 'main']).status).toBe(0);
      expect(git(dir, ['config', 'http.receivepack', 'true']).status).toBe(0);
      expect(git(seed, ['push', '-q', dir, 'main']).status).toBe(0);
    }
    // The lead's project: the owner's clone, made before the wall, with GitHub as origin.
    mkdirSync(join(home, 'dev'), { recursive: true });
    expect(git(root, ['clone', '-q', join(repos, 'Harborlight/notes.git'), project]).status).toBe(
      0,
    );
    expect(
      git(project, ['remote', 'set-url', 'origin', 'https://github.com/Harborlight/notes']).status,
    ).toBe(0);

    const parsed = parseConfig(
      {
        leads: [
          {
            name: 'harborlight',
            projects: [project],
            githubRepos: ['Harborlight/notes'],
            tools: ['gh'],
            boardWall: true,
            boardId: 'w-harbor',
          },
        ],
      },
      home,
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const config = parsed.config;
    const lead = config.leads[0];
    if (!lead) throw new Error('fixture has one lead');
    const tokens = join(home, '.config/claude-workspaces/git-proxy');
    const leads = () => readLeadTokens(config.leads, tokens);

    github = await startFakeGithub(repos, credential);
    gitProxy = createGitProxy({
      credential,
      upstream: github.url,
      api: `${github.url}/api`,
      leads,
      log: (l) => logs.push(l),
    });
    await new Promise<void>((r) => gitProxy.listen(0, '127.0.0.1', () => r()));
    apiServer = http.createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (d: Buffer) => parts.push(d));
      req.on('end', () => {
        const body = Buffer.concat(parts).toString('utf8');
        const op = /(?:query|mutation)\s+(\w+)/.exec(body)?.[1] ?? `${req.method} ${req.url}`;
        api.push({ op, authorization: String(req.headers.authorization), body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(apiAnswer(body)));
      });
    });
    await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', () => r()));
    ghProxy = createGhProxy({
      credential,
      api: `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`,
      leads,
      log: (l) => logs.push(`gh ${l}`),
    });
    mkdirSync(join(ghSocket, '..'), { recursive: true, mode: 0o700 });
    await new Promise<void>((r) => ghProxy.listen(ghSocket, () => r()));

    // What the launch writes and sets, as `lead-sandbox.ts` does.
    const proxyUrl = `http://127.0.0.1:${(gitProxy.address() as AddressInfo).port}`;
    const files = ensureGitProxyFiles(lead.name, gitProxyLeadDir(home, lead.name), proxyUrl);
    const tools = ensureLeadTools(lead, home, null, (p) => p, bare.PATH, ghSocket);
    const m: Machine = { home, uid, realpath: (p) => p };
    profile = join(root, 'harborlight.sb');
    writeFileSync(profile, buildProfile(lead, config, m));
    // No variable from this process's own environment: no GH_TOKEN, no GITHUB_TOKEN.
    leadEnv = {
      ...bare,
      ...tools,
      ...gitProxyEnv(files.gitconfig),
      PATH: `${files.bin}:${tools.PATH}`,
    };
  }, 60_000);

  afterAll(async () => {
    await new Promise((r) => gitProxy?.close(r));
    await new Promise((r) => ghProxy?.close(r));
    await new Promise((r) => apiServer?.close(r));
    await github?.close();
    rmSync(join(ghSocket, '..'), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('cannot add a worktree itself, which is why the proxy makes it', async () => {
    const r = await inside(`git worktree add -q ${join(project, '.claude', 'worktrees', 'own')}`);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('Operation not permitted');
  }, 60_000);

  it('makes a branch and a worktree through the proxy, commits there, and pushes', async () => {
    const made = await inside('git fetch -q origin && cw-worktree fix-1 fix/one origin/main');
    expect(made.status, made.out).toBe(0);
    expect(made.out).toContain(worktree);
    expect(made.out).toContain('gh pr create -R Harborlight/notes --head fix/one');
    const pushed = await inside(
      "echo 'from inside the wall' > note.md && git add note.md && git commit -q -m 'a walled commit' && git push -q",
      worktree,
    );
    expect(pushed.status, pushed.out).toBe(0);
    const head = git(worktree, ['rev-parse', 'HEAD']).stdout.trim();
    expect(upstreamRef('Harborlight/notes', 'refs/heads/fix/one')).toBe(head);
    expect(git(worktree, ['log', '-1', '--format=%s']).stdout.trim()).toBe('a walled commit');
    expect(logs).toContain(`200 harborlight worktree ${worktree} on fix/one`);
  }, 60_000);

  it("leaves the project's and the worktree's git settings read only to the lead", async () => {
    const admin = join(project, '.git', 'worktrees', 'fix-1');
    // The positive control: the lead writes a plain file in the same worktree.
    expect((await inside(`echo ok > '${join(worktree, 'plain.md')}'`)).status).toBe(0);
    for (const path of [
      join(project, '.git', 'config'),
      join(project, '.git', 'hooks', 'pre-commit'),
      join(project, '.git', 'info', 'attributes'),
      join(admin, 'commondir'),
      join(admin, 'gitdir'),
      join(admin, 'config.worktree'),
      join(worktree, '.git'),
    ]) {
      const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
      const r = await inside(`echo '[core] fsmonitor = /tmp/x' >> '${path}'`);
      expect(r.status, path).not.toBe(0);
      expect(existsSync(path) ? readFileSync(path, 'utf8') : null, path).toBe(before);
    }
    const set = await inside('git config core.hooksPath /tmp', worktree);
    expect(set.status).not.toBe(0);
  }, 60_000);

  describe.skipIf(GH === '')('with the real gh', () => {
    it('opens a PR on its own repo, the owner credential going upstream only', async () => {
      api.length = 0;
      expect(Object.keys(leadEnv).filter((k) => /^(GITHUB_TOKEN|GH_ENTERPRISE)/.test(k))).toEqual(
        [],
      );
      expect(Object.values(leadEnv).join('\n')).not.toContain(credential);
      const r = await inside(
        'gh pr create -R Harborlight/notes --head fix/one --base main --title "A walled PR" --body "From inside the wall."',
        worktree,
      );
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('https://github.com/Harborlight/notes/pull/7');
      const create = api.find((a) => a.op === 'PullRequestCreate');
      expect(JSON.parse(create?.body ?? '{}').variables.input).toMatchObject({
        repositoryId: 'R_harbor',
        headRefName: 'fix/one',
        baseRefName: 'main',
        title: 'A walled PR',
      });
      expect(new Set(api.map((a) => a.authorization))).toEqual(new Set([`token ${credential}`]));
    }, 60_000);

    it('is refused a PR on another repo, by name and by a node id, with nothing created', async () => {
      api.length = 0;
      const byName = await inside(
        'gh pr create -R Riverbend/private --head fix/one --base main --title t --body b',
        worktree,
      );
      expect(byName.status).not.toBe(0);
      expect(byName.out).toContain("Riverbend/private is not in the lead's githubRepos");
      const query =
        'mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { id url } } }';
      writeFileSync(
        join(worktree, 'create.json'),
        JSON.stringify({
          query,
          variables: {
            input: { repositoryId: 'R_river', baseRefName: 'main', headRefName: 'x', title: 't' },
          },
        }),
      );
      const byId = await inside(
        `gh api graphql --input '${join(worktree, 'create.json')}'`,
        worktree,
      );
      expect(byId.status).not.toBe(0);
      expect(byId.out).toContain('node R_river is not in a repo');
      // Upstream saw only the proxy's own lookup of the id, and no create.
      expect(api.map((a) => a.op)).toEqual(['GhProxyNodes']);
    }, 60_000);
  });
});
