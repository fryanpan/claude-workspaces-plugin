/**
 * The GitHub proxy's protocol reading and the lead's side of it: the config
 * keys, the profile rules, the git config the wrapper writes. The last block
 * runs the profile under the real `sandbox-exec` and skips where there is none.
 */
import { spawn, spawnSync } from 'node:child_process';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureGitProxyFiles, gitProxyLeadDir, readLeadTokens } from './git-proxy-lead.ts';
import {
  addNoThin,
  basicPassword,
  headSymref,
  parseReceivePack,
  parseRepoRequest,
} from './git-proxy-lib.ts';
import { type Machine, SANDBOX_EXEC, buildProfile, parseConfig } from './lead-sandbox-lib.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);

function pkt(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
}
const FLUSH = Buffer.from('0000');

describe('parseRepoRequest', () => {
  it('reads the smart-HTTP endpoints of one repo, and nothing else', () => {
    expect(
      parseRepoRequest('GET', '/Harborlight/notes.git/info/refs?service=git-receive-pack'),
    ).toEqual({ repo: 'Harborlight/notes', kind: 'refs', service: 'git-receive-pack' });
    expect(parseRepoRequest('POST', '/harborlight/notes/git-upload-pack')).toEqual({
      repo: 'harborlight/notes',
      kind: 'rpc',
      service: 'git-upload-pack',
    });
    for (const [method, url] of [
      ['GET', '/harborlight/notes.git/info/refs'], // dumb HTTP
      ['GET', '/harborlight/notes.git/HEAD'],
      ['GET', '/harborlight/notes.git/git-upload-pack'],
      ['POST', '/harborlight/notes.git/info/refs?service=git-upload-pack'],
      ['POST', '/harborlight/../riverbend/notes.git/git-upload-pack'],
      ['POST', '/harborlight/%2e%2e/git-upload-pack'],
      ['POST', '/a/b/c.git/git-upload-pack'],
      ['POST', '/harborlight/..git/git-upload-pack'],
    ] as const)
      expect(parseRepoRequest(method, url), url).toBeNull();
  });
});

describe('basicPassword', () => {
  it('takes the password half of a Basic header', () => {
    const h = `Basic ${Buffer.from('harborlight-lead:tok:en').toString('base64')}`;
    expect(basicPassword(h)).toBe('tok:en');
    expect(basicPassword(undefined)).toBeNull();
    expect(basicPassword('Bearer abc')).toBeNull();
  });
});

describe('parseReceivePack', () => {
  it('reads every command, skips push options, and finds the pack', () => {
    const body = Buffer.concat([
      pkt(`${A} ${B} refs/heads/main\0report-status push-options\n`),
      pkt(`${Z} ${B} refs/heads/new\n`),
      FLUSH,
      pkt('ci.skip'),
      FLUSH,
      Buffer.from('PACKrest'),
    ]);
    const r = parseReceivePack(body);
    expect(r.ok && r.updates).toEqual([
      { old: A, new: B, ref: 'refs/heads/main' },
      { old: Z, new: B, ref: 'refs/heads/new' },
    ]);
    expect(r.ok && r.pack.toString()).toBe('PACKrest');
  });

  it('passes the bare flush git probes with, and refuses what it cannot read', () => {
    expect(parseReceivePack(FLUSH)).toMatchObject({ ok: true, updates: [] });
    for (const body of [
      Buffer.from('zzzz'),
      pkt(`${A} ${B}\n`),
      pkt('push-cert\0report-status\n'),
      Buffer.concat([pkt(`${A} ${B} refs/heads/main\0x\n`), FLUSH, Buffer.from('JUNK')]),
      pkt(`${A} ${B} refs/heads/main\0x\n`), // no flush
    ])
      expect(parseReceivePack(body).ok, body.toString()).toBe(false);
  });
});

describe('addNoThin', () => {
  it('adds no-thin to the first ref line and keeps every other byte', () => {
    const rest = Buffer.concat([pkt(`${B} refs/heads/dev\n`), FLUSH]);
    const advert = Buffer.concat([
      pkt('# service=git-receive-pack\n'),
      FLUSH,
      pkt(`${A} refs/heads/main\0report-status delete-refs\n`),
      rest,
    ]);
    const out = addNoThin(advert);
    expect(out?.toString()).toContain('report-status delete-refs no-thin\n');
    expect(out?.subarray(out.length - rest.length).equals(rest)).toBe(true);
    expect(addNoThin(Buffer.from('<html>'))).toBeNull();
  });
});

describe('headSymref', () => {
  it("reads HEAD's target from an upload-pack advertisement, and nothing from one without it", () => {
    const advert = (first: string) =>
      Buffer.concat([pkt('# service=git-upload-pack\n'), FLUSH, pkt(first), FLUSH]);
    expect(
      headSymref(advert(`${A} HEAD\0multi_ack symref=HEAD:refs/heads/trunk agent=git\n`)),
    ).toBe('refs/heads/trunk');
    expect(headSymref(advert(`${A} refs/heads/main\0report-status delete-refs\n`))).toBeNull();
    expect(headSymref(advert(`${A} HEAD\0symref=FOO:refs/heads/x\n`))).toBeNull();
    expect(headSymref(Buffer.from('<html>'))).toBeNull();
  });
});

describe('the config and the profile', () => {
  const home = '/fixture/home/saltmarsh';
  const m: Machine = { home, uid: 501, realpath: (p) => p };
  const parse = (extra: object) =>
    parseConfig(
      {
        leads: [
          { name: 'harborlight-lead', projects: ['/r/harborlight'], ...extra },
          { name: 'riverbend-lead', projects: ['/r/riverbend'] },
        ],
      },
      home,
    );

  it('reads githubRepos and the port, and refuses a bad one', () => {
    const ok = parse({ githubRepos: ['Harborlight/notes'] });
    expect(ok.ok && ok.config.leads[0]?.githubRepos).toEqual(['Harborlight/notes']);
    expect(ok.ok && ok.config.gitProxyPort).toBe(8793);
    for (const bad of [['notes'], ['a/b/c'], ['a/b.git'], ['../b'], 'a/b'])
      expect(parse({ githubRepos: bad }).ok, String(bad)).toBe(false);
  });

  it('walls a lead without repos off the proxy, and opens its token folder read only', () => {
    const parsed = parse({ githubRepos: ['Harborlight/notes'] });
    if (!parsed.ok) throw new Error(parsed.error);
    const [harborlight, riverbend] = parsed.config.leads;
    if (!harborlight || !riverbend) throw new Error('fixture');
    const own = buildProfile(harborlight, parsed.config, m);
    const other = buildProfile(riverbend, parsed.config, m);
    const deny = '(deny network-outbound (remote ip "localhost:8793"))';
    expect(own).not.toContain(deny);
    expect(other).toContain(deny);
    const dir = gitProxyLeadDir(home, 'harborlight-lead');
    const lines = own.split('\n');
    const read = lines.indexOf(`(allow file-read* (subpath "${dir}")) ; git proxy token`);
    const nowrite = lines.indexOf(`(deny file-write* (subpath "${dir}")) ; git proxy token`);
    expect(read).toBeGreaterThan(
      lines.indexOf(`(deny file-read* file-write* (subpath "${home}")) ; protected`),
    );
    expect(nowrite).toBeGreaterThan(read);
    expect(other).not.toContain(dir);
  });
});

describe('the files the wrapper writes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-proxy-lead-')));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('makes a token once, mode 600, and maps it to the lead', () => {
    const dir = join(root, 'harborlight-lead');
    const first = ensureGitProxyFiles('harborlight-lead', dir, 'http://127.0.0.1:8793');
    const token = readFileSync(first.token, 'utf8');
    ensureGitProxyFiles('harborlight-lead', dir, 'http://127.0.0.1:8793');
    expect(readFileSync(first.token, 'utf8')).toBe(token);
    expect(token.length).toBeGreaterThanOrEqual(43);
    if (process.platform !== 'win32') {
      const mode = spawnSync(
        'stat',
        process.platform === 'darwin' ? ['-f', '%Lp', first.token] : ['-c', '%a', first.token],
        { encoding: 'utf8' },
      );
      expect(mode.stdout.trim()).toBe('600');
    }
    const leads = readLeadTokens(
      [
        { name: 'harborlight-lead', githubRepos: ['Harborlight/Notes'] },
        { name: 'riverbend-lead', githubRepos: ['Riverbend/x'] }, // no token file
      ],
      root,
    );
    expect([...leads.keys()]).toEqual([token]);
    expect(leads.get(token)?.repos.has('harborlight/notes')).toBe(true);
  });

  it('rewrites every GitHub URL form and hands git the token, and no other helper', () => {
    const dir = join(root, 'harborlight-lead');
    const { gitconfig } = ensureGitProxyFiles('harborlight-lead', dir, 'http://127.0.0.1:8793');
    const git = (...args: string[]) =>
      spawnSync('git', ['config', '--file', gitconfig, ...args], { encoding: 'utf8' }).stdout;
    expect(git('--get-all', 'url.http://127.0.0.1:8793/.insteadof').split('\n')).toEqual([
      'git@github.com:',
      'ssh://git@github.com/',
      'https://github.com/',
      '',
    ]);
    const fill = spawnSync('git', ['credential', 'fill'], {
      input: 'protocol=http\nhost=127.0.0.1:8793\n\n',
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '2',
        // A helper configured before ours, as the owner's osxkeychain is: dropped.
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '!echo password=from-another-helper',
        GIT_CONFIG_KEY_1: 'include.path',
        GIT_CONFIG_VALUE_1: gitconfig,
      },
    });
    const token = readFileSync(join(dir, 'token'), 'utf8');
    expect(fill.stdout).toContain(`password=${token}\n`);
    expect(fill.stdout).toContain('username=harborlight-lead\n');
    expect(fill.stdout).not.toContain('from-another-helper');
  });
});

const HAVE_SANDBOX = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);

describe.skipIf(!HAVE_SANDBOX)('the proxy rules under the real sandbox-exec', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-proxy-sandbox-')));
  const home = join(root, 'home');
  let server: http.Server;
  let port = 0;
  beforeAll(async () => {
    server = http.createServer((_q, r) => r.end('proxy'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  });

  /** Run a shell line inside `lead`'s profile, without blocking the listener above. */
  const inside = (lead: string, script: string) => {
    const harborlight = join(root, 'harborlight');
    const riverbend = join(root, 'riverbend');
    for (const d of [harborlight, riverbend, home]) mkdirSync(d, { recursive: true });
    const parsed = parseConfig(
      {
        leads: [
          { name: 'harborlight-lead', projects: [harborlight], githubRepos: ['Harborlight/notes'] },
          { name: 'riverbend-lead', projects: [riverbend] },
        ],
        gitProxyPort: port,
      },
      home,
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const l = parsed.config.leads.find((x) => x.name === lead);
    if (!l) throw new Error(lead);
    const m: Machine = { home, uid: 99999, realpath: (p) => p };
    const file = join(root, `${lead}.sb`);
    writeFileSync(file, buildProfile(l, parsed.config, m));
    return new Promise<number | null>((resolve) => {
      const c = spawn(SANDBOX_EXEC, ['-f', file, '/bin/sh', '-c', script], {
        cwd: l.projects[0],
        stdio: 'ignore',
      });
      c.on('close', resolve);
    });
  };

  it('lets a lead with repos reach the proxy and read its token, and refuses the rest', async () => {
    const dir = gitProxyLeadDir(home, 'harborlight-lead');
    const { token } = ensureGitProxyFiles('harborlight-lead', dir, `http://127.0.0.1:${port}`);
    const curl = `/usr/bin/curl -sf -m 5 http://127.0.0.1:${port}/`;
    expect(await inside('harborlight-lead', curl)).toBe(0);
    expect(await inside('riverbend-lead', curl)).not.toBe(0);
    expect(await inside('harborlight-lead', `cat '${token}' >/dev/null`)).toBe(0);
    expect(await inside('harborlight-lead', `echo x >> '${token}'`)).not.toBe(0);
    expect(await inside('harborlight-lead', `echo x > '${dir}/gitconfig'`)).not.toBe(0);
    expect(await inside('riverbend-lead', `cat '${token}'`)).not.toBe(0);
  }, 30_000);
});
