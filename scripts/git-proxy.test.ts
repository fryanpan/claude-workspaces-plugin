/**
 * The GitHub proxy, end to end: a real `git` client configured the way the
 * lead-sandbox wrapper configures a lead, through a recording tap, into the
 * proxy, out to a stand-in for GitHub (`git-proxy-test-upstream.ts`) that
 * serves bare repos with `git http-backend`. The credential is a fake
 * string; nothing here reaches GitHub or reads a real token.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGitProxyFiles, gitProxyEnv, readLeadTokens } from './git-proxy-lead.ts';
import { credentialForms } from './git-proxy-lib.ts';
import { createGitProxy } from './git-proxy-server.ts';
import { type FakeGithub, startFakeGithub } from './git-proxy-test-upstream.ts';

const FAKE_CREDENTIAL = 'fake-owner-credential-9f2c41d7e8b3a6';

interface Exchange {
  request: string;
  response: string;
}

/** A pass-through between git and the proxy that keeps every byte both ways, headers included. */
function startTap(target: string, kept: Exchange[]): Promise<{ url: string; server: http.Server }> {
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      const exchange: Exchange = {
        request: `${req.method} ${req.url}\n${JSON.stringify(req.headers)}\n${body.toString('latin1')}`,
        response: '',
      };
      kept.push(exchange);
      const { host: _host, 'transfer-encoding': _te, ...headers } = req.headers;
      const up = http.request(new URL(req.url ?? '/', target), {
        method: req.method,
        headers: { ...headers, 'content-length': String(body.length) },
      });
      up.on('response', (r) => {
        const out: Buffer[] = [];
        r.on('data', (d: Buffer) => out.push(d));
        r.on('end', () => {
          const all = Buffer.concat(out);
          exchange.response = `${r.statusCode}\n${JSON.stringify(r.headers)}\n${all.toString('latin1')}`;
          const { 'transfer-encoding': _te, ...h } = r.headers;
          res.writeHead(r.statusCode ?? 502, { ...h, 'content-length': String(all.length) });
          res.end(all);
        });
      });
      up.end(body);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }),
    ),
  );
}

const HAVE_GIT = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!HAVE_GIT)('the GitHub proxy, with a real git client', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-proxy-test-')));
  const repos = join(root, 'upstream');
  const home = join(root, 'home');
  const tokens = join(root, 'tokens');
  const logs: string[] = [];
  const kept: Exchange[] = [];
  let github: FakeGithub;
  let proxy: http.Server;
  let tap: http.Server;
  let leadEnv: Record<string, string>;
  let token = '';

  const leads = [
    { name: 'harborlight-lead', githubRepos: ['Harborlight/notes', 'harborlight/echo'] },
    { name: 'riverbend-lead', githubRepos: [] },
  ];

  /** No user config at all, so only what is passed in applies. */
  const bareEnv = () => ({
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Alice',
    GIT_AUTHOR_EMAIL: 'alice@example.invalid',
    GIT_COMMITTER_NAME: 'Alice',
    GIT_COMMITTER_EMAIL: 'alice@example.invalid',
  });
  /** Local git: seeding the upstream, committing, reading a ref. Never the proxy. */
  const git = (cwd: string, args: string[]) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', env: bareEnv() });
  /** git as the lead runs it: GitHub's URLs, rewritten onto the proxy. */
  const gitEnv = () => ({ ...bareEnv(), ...leadEnv });
  /**
   * The lead's git, started without blocking: the tap, the proxy and the
   * stand-in upstream all answer on this process's own event loop.
   */
  const lead = (cwd: string, args: string[]) =>
    new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn('git', args, { cwd, env: gitEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      child.on('close', (status) => resolve({ status, stderr }));
    });
  const upstreamRef = (repo: string, ref: string) =>
    git(root, [
      '--git-dir',
      join(repos, `${repo}.git`),
      'rev-parse',
      '--verify',
      '-q',
      ref,
    ]).stdout.trim();

  const commit = (dir: string, file: string, text: string) => {
    writeFileSync(join(dir, file), text);
    expect(git(dir, ['add', file]).status).toBe(0);
    expect(git(dir, ['commit', '-q', '-m', text]).status).toBe(0);
    return git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  };

  beforeAll(async () => {
    mkdirSync(home, { recursive: true });
    // Upstream repos, seeded with one commit each by a plain file push.
    const seed = join(root, 'seed');
    mkdirSync(seed);
    expect(git(seed, ['init', '-q', '-b', 'main']).status).toBe(0);
    commit(seed, 'README.md', 'first');
    for (const repo of ['Harborlight/notes', 'Riverbend/private']) {
      const dir = join(repos, `${repo}.git`);
      mkdirSync(dir, { recursive: true });
      expect(git(dir, ['init', '-q', '--bare', '-b', 'main']).status).toBe(0);
      expect(git(dir, ['config', 'http.receivepack', 'true']).status).toBe(0);
      expect(git(seed, ['push', '-q', dir, 'main']).status).toBe(0);
    }
    github = await startFakeGithub(repos, FAKE_CREDENTIAL);
    proxy = createGitProxy({
      credential: FAKE_CREDENTIAL,
      upstream: github.url,
      api: `${github.url}/api`,
      leads: () => readLeadTokens(leads, tokens),
      log: (l) => logs.push(l),
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const t = await startTap(proxyUrl, kept);
    tap = t.server;
    // The files the wrapper writes for a lead, pointing at the tap.
    const files = ensureGitProxyFiles('harborlight-lead', join(tokens, 'harborlight-lead'), t.url);
    token = spawnSync('cat', [files.token], { encoding: 'utf8' }).stdout;
    leadEnv = gitProxyEnv(files.gitconfig);
  });

  afterAll(async () => {
    await new Promise((r) => tap?.close(r));
    await new Promise((r) => proxy?.close(r));
    await github?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('clones an allowed repo and pushes a fast-forward that reaches the upstream', async () => {
    const work = join(root, 'work');
    const clone = await lead(root, ['clone', '-q', 'git@github.com:Harborlight/notes.git', work]);
    expect(clone.status, clone.stderr).toBe(0);
    const sha = commit(work, 'a.md', 'second');
    const push = await lead(work, ['push', '-q', 'origin', 'main']);
    expect(push.status, push.stderr).toBe(0);
    expect(upstreamRef('Harborlight/notes', 'main')).toBe(sha);
    // A new branch is a create, which needs no ancestry.
    const branch = await lead(work, ['push', '-q', 'origin', 'main:refs/heads/feature']);
    expect(branch.status, branch.stderr).toBe(0);
    expect(upstreamRef('Harborlight/notes', 'feature')).toBe(sha);
  });

  it('allows a fast-forward whose new commits sit on another branch the upstream has', async () => {
    const work = join(root, 'work');
    // feature moves ahead; main then jumps onto it, so the pack's only
    // commit has feature's tip, not main's, as its parent: the compare API decides.
    commit(work, 'b.md', 'on feature');
    expect((await lead(work, ['push', '-q', 'origin', 'HEAD:refs/heads/feature'])).status).toBe(0);
    const sha = commit(work, 'c.md', 'third');
    const push = await lead(work, ['push', '-q', 'origin', 'HEAD:main']);
    expect(push.status, push.stderr).toBe(0);
    expect(upstreamRef('Harborlight/notes', 'main')).toBe(sha);
    expect(github.seen.some((s) => s.url.includes('/compare/'))).toBe(true);
  });

  it('refuses a force-push to the default branch, and the upstream keeps its commit', async () => {
    const work = join(root, 'work');
    const before = upstreamRef('Harborlight/notes', 'main');
    expect(git(work, ['commit', '-q', '--amend', '-m', 'rewritten']).status).toBe(0);
    const push = await lead(work, ['push', '-q', '--force', 'origin', 'HEAD:main']);
    expect(push.status).not.toBe(0);
    expect(upstreamRef('Harborlight/notes', 'main')).toBe(before);
    // Reset backwards: an empty pack, the new sha already upstream.
    const back = await lead(work, [
      'push',
      '-q',
      '--force',
      'origin',
      `${before}~2:refs/heads/main`,
    ]);
    expect(back.status).not.toBe(0);
    expect(upstreamRef('Harborlight/notes', 'main')).toBe(before);
    expect(logs.filter((l) => l.includes('is the default branch'))).toHaveLength(2);
  });

  it('lets a force-push to any other branch through, as a rebase needs', async () => {
    const work = join(root, 'work');
    const feature = upstreamRef('Harborlight/notes', 'feature');
    // feature rebuilt from its parent: a sibling of its tip, as a rebase leaves it.
    const rewritten = git(work, [
      'commit-tree',
      'HEAD^{tree}',
      '-p',
      `${feature}~1`,
      '-m',
      'rebased',
    ]).stdout.trim();
    expect(
      git(work, ['merge-base', '--is-ancestor', feature, rewritten]).status,
      'the fixture must be a real non-fast-forward',
    ).not.toBe(0);
    const push = await lead(work, [
      'push',
      '-q',
      '--force',
      'origin',
      `${rewritten}:refs/heads/feature`,
    ]);
    expect(push.status, push.stderr).toBe(0);
    expect(upstreamRef('Harborlight/notes', 'feature')).toBe(rewritten);
  });

  it("reads the default branch from upstream's HEAD, not from its name", async () => {
    const work = join(root, 'work');
    const gitDir = join(repos, 'Harborlight/notes.git');
    const head = (ref: string) =>
      expect(git(root, ['--git-dir', gitDir, 'symbolic-ref', 'HEAD', ref]).status).toBe(0);
    head('refs/heads/feature');
    try {
      const main = upstreamRef('Harborlight/notes', 'main');
      const feature = upstreamRef('Harborlight/notes', 'feature');
      // main goes back to feature's commit, which does not hold main's tip: allowed now.
      const toMain = await lead(work, [
        'push',
        '-q',
        '--force',
        'origin',
        `${feature}:refs/heads/main`,
      ]);
      expect(toMain.status, toMain.stderr).toBe(0);
      expect(upstreamRef('Harborlight/notes', 'main')).toBe(feature);
      // feature is the default now, so moving it back is refused.
      const toFeature = await lead(work, [
        'push',
        '-q',
        '--force',
        'origin',
        `${feature}~1:refs/heads/feature`,
      ]);
      expect(toFeature.status).not.toBe(0);
      expect(upstreamRef('Harborlight/notes', 'feature')).toBe(feature);
      // Put main back where the later cases expect it.
      expect(
        (await lead(work, ['push', '-q', '--force', 'origin', `${main}:refs/heads/main`])).status,
      ).toBe(0);
    } finally {
      head('refs/heads/main');
    }
  });

  it('refuses a force-push anywhere when the default branch cannot be read', async () => {
    const work = join(root, 'work');
    const gitDir = join(repos, 'Harborlight/notes.git');
    // HEAD names a branch that does not exist, so upstream advertises no HEAD at all.
    const head = (ref: string) =>
      expect(git(root, ['--git-dir', gitDir, 'symbolic-ref', 'HEAD', ref]).status).toBe(0);
    head('refs/heads/nowhere');
    try {
      const feature = upstreamRef('Harborlight/notes', 'feature');
      const sibling = git(work, [
        'commit-tree',
        'HEAD^{tree}',
        '-p',
        `${feature}~1`,
        '-m',
        'rebased again',
      ]).stdout.trim();
      const push = await lead(work, [
        'push',
        '-q',
        '--force',
        'origin',
        `${sibling}:refs/heads/feature`,
      ]);
      expect(push.status).not.toBe(0);
      expect(upstreamRef('Harborlight/notes', 'feature')).toBe(feature);
      expect(logs.some((l) => l.includes('the default branch could not be read'))).toBe(true);
    } finally {
      head('refs/heads/main');
    }
  });

  it('refuses a branch delete, and the branch is still there', async () => {
    const work = join(root, 'work');
    const before = upstreamRef('Harborlight/notes', 'feature');
    const push = await lead(work, ['push', '-q', 'origin', ':refs/heads/feature']);
    expect(push.status).not.toBe(0);
    expect(upstreamRef('Harborlight/notes', 'feature')).toBe(before);
    expect(logs.some((l) => l.includes('deleting refs/heads/feature is refused'))).toBe(true);
  });

  it('refuses a repo the lead does not list, for a fetch and for a push', async () => {
    const other = join(root, 'other');
    const clone = await lead(root, [
      'clone',
      '-q',
      'https://github.com/Riverbend/private.git',
      other,
    ]);
    expect(clone.status).not.toBe(0);
    const work = join(root, 'work');
    const before = upstreamRef('Riverbend/private', 'main');
    const push = await lead(work, [
      'push',
      '-q',
      'https://github.com/Riverbend/private.git',
      'HEAD:main',
    ]);
    expect(push.status).not.toBe(0);
    expect(upstreamRef('Riverbend/private', 'main')).toBe(before);
    expect(
      logs.filter((l) => l.startsWith('403 harborlight-lead Riverbend/private')),
    ).not.toHaveLength(0);
    expect(github.seen.some((s) => s.url.includes('Riverbend'))).toBe(false);
  });

  it('answers 401 to no token and to a token no lead holds', async () => {
    const at = (proxy.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${at}/Harborlight/notes.git/info/refs?service=git-upload-pack`;
    const none = await fetch(url);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/^Basic /);
    const forged = Buffer.from(`harborlight-lead:${'x'.repeat(token.length)}`).toString('base64');
    const wrong = await fetch(url, { headers: { Authorization: `Basic ${forged}` } });
    expect(wrong.status).toBe(401);
    // The owner's own credential is not a lead token either.
    const owner = Buffer.from(`x-access-token:${FAKE_CREDENTIAL}`).toString('base64');
    expect((await fetch(url, { headers: { Authorization: `Basic ${owner}` } })).status).toBe(401);
    // The control: the lead's real token is let in.
    const real = Buffer.from(`harborlight-lead:${token}`).toString('base64');
    expect((await fetch(url, { headers: { Authorization: `Basic ${real}` } })).status).toBe(200);
  });

  it('strips the credential from an upstream error that repeats it', async () => {
    const at = (proxy.address() as AddressInfo).port;
    const real = Buffer.from(`harborlight-lead:${token}`).toString('base64');
    const res = await fetch(
      `http://127.0.0.1:${at}/harborlight/echo.git/info/refs?service=git-upload-pack`,
      { headers: { Authorization: `Basic ${real}` } },
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('upstream saw Basic [redacted] ([redacted])');
  });

  it("never lets the owner's credential reach the lead, its requests, or a log line", async () => {
    // The positive control: the upstream did get it, on every request it saw.
    expect(github.seen.length).toBeGreaterThan(5);
    for (const s of github.seen)
      expect(String(s.headers.authorization)).toContain(
        s.url.startsWith('/api/') ? FAKE_CREDENTIAL : credentialForms(FAKE_CREDENTIAL)[1],
      );
    expect(kept.length).toBeGreaterThan(5);
    const forms = credentialForms(FAKE_CREDENTIAL);
    for (const e of kept)
      for (const f of forms) {
        expect(e.request).not.toContain(f);
        expect(e.response).not.toContain(f);
      }
    for (const line of logs) for (const f of forms) expect(line).not.toContain(f);
    // What the lead's git reads: its config, its token, its environment.
    const files = spawnSync('cat', [join(tokens, 'harborlight-lead', 'gitconfig')], {
      encoding: 'utf8',
    }).stdout;
    for (const f of forms) {
      expect(files).not.toContain(f);
      expect(token).not.toContain(f);
      expect(JSON.stringify(leadEnv)).not.toContain(f);
    }
  });
});
