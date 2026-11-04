/**
 * gh inside a generated profile (`gh-proxy-lead.ts`), talking to the gh
 * proxy (`gh-proxy-server.ts`) on its socket, in front of a stand-in for
 * api.github.com (`gh-proxy-test-server.ts`, in a process of its own). The
 * real gh binary runs when one is installed; the credential is a random
 * string made here, and nothing reaches GitHub.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
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
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ghProxySocket, leadGhConfig } from './gh-proxy-lead.ts';
import { gitProxyLeadDir, readLeadTokens } from './git-proxy-lead.ts';
import { ghRows } from './lead-sandbox-escapes.ts';
import { type Machine, SANDBOX_EXEC, buildProfile, parseConfig } from './lead-sandbox-lib.ts';
import { ensureLeadTools } from './lead-sandbox-tools.ts';

function config(home: string) {
  const parsed = parseConfig(
    {
      leads: [
        {
          name: 'riverbend',
          projects: [`${home}/dev/riverbend`],
          githubRepos: ['a/b'],
          tools: ['gh'],
        },
        { name: 'saltmarsh', projects: [`${home}/dev/saltmarsh`], githubRepos: ['a/b'] },
      ],
    },
    home,
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.config;
}

describe('the gh tool in the config and the profile', () => {
  const m: Machine = { home: '/fixture/home/harborlight', uid: 501, realpath: (p) => p };

  it('needs githubRepos', () => {
    const parsed = parseConfig(
      { leads: [{ name: 'riverbend', projects: ['/p'], tools: ['gh'] }] },
      m.home,
    );
    expect(parsed.ok || parsed.error).toContain('githubRepos');
  });

  it("refuses the proxy's socket to a lead without gh, and leaves it to one with gh", () => {
    const c = config(m.home);
    const [withGh, without] = c.leads;
    if (!withGh || !without) throw new Error('fixture has two leads');
    const rule = `(deny network-outbound (remote unix-socket (path-literal "${ghProxySocket(501)}")))`;
    expect(buildProfile(without, c, m)).toContain(rule);
    expect(buildProfile(withGh, c, m)).not.toContain(rule);
  });

  it("points gh's config at the socket", () => {
    expect(leadGhConfig('riverbend', '/s/api.sock')).toContain('http_unix_socket: /s/api.sock');
  });
});

const GH = spawnSync('/bin/sh', ['-c', 'command -v gh'], { encoding: 'utf8' }).stdout.trim();
const RUN = process.platform === 'darwin' && existsSync(SANDBOX_EXEC) && GH !== '';

describe.skipIf(!RUN)('gh under the real sandbox-exec', () => {
  const credential = `fake-owner-${randomBytes(12).toString('hex')}`;
  const uid = 90_000 + Math.floor(Math.random() * 9_000);
  const socket = ghProxySocket(uid);
  let root = '';
  let home = '';
  let seenFile = '';
  let server: ChildProcess | null = null;
  const profiles: Record<string, string> = {};
  let env: Record<string, string> = {};
  const seen = (): { url: string; authorization: string }[] =>
    existsSync(seenFile)
      ? readFileSync(seenFile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  beforeAll(async () => {
    root = realpathSync(mkdtempSync('/private/tmp/ghw-'));
    home = join(root, 'home');
    seenFile = join(root, 'seen.jsonl');
    const c = config(home);
    const m: Machine = { home, uid, realpath: (p) => p };
    for (const lead of c.leads) {
      mkdirSync(join(home, 'dev', lead.name), { recursive: true });
      const toolsEnv = ensureLeadTools(lead, home, null, (p) => p, process.env.PATH, socket);
      if (lead.tools.includes('gh')) env = toolsEnv;
      const file = join(root, `${lead.name}.sb`);
      writeFileSync(file, buildProfile(lead, c, m));
      profiles[lead.name] = file;
    }
    // saltmarsh names repos but not gh: its token must not open the proxy.
    mkdirSync(gitProxyLeadDir(home, 'saltmarsh'), { recursive: true });
    writeFileSync(
      join(gitProxyLeadDir(home, 'saltmarsh'), 'token'),
      randomBytes(32).toString('base64url'),
    );
    const leads = [
      ...readLeadTokens(c.leads, join(home, '.config/claude-workspaces/git-proxy')),
    ].map(([token, l]) => ({ token, name: l.name, repos: [...l.repos], gh: l.gh }));
    mkdirSync(join(socket, '..'), { recursive: true, mode: 0o700 });
    server = spawn('bun', [join(import.meta.dirname, 'gh-proxy-test-server.ts')], {
      env: {
        ...process.env,
        GHP_SOCKET: socket,
        GHP_CREDENTIAL: credential,
        GHP_LEADS: JSON.stringify(leads),
        GHP_SEEN: seenFile,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise<void>((done, fail) => {
      server?.stdout?.on('data', (d: Buffer) => d.toString().includes('ready') && done());
      server?.once('exit', (code) => fail(new Error(`the test server exited ${code}`)));
    });
  }, 30_000);

  afterAll(() => {
    server?.kill();
    rmSync(join(socket, '..'), { recursive: true, force: true });
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const gh = (lead: string, args: string[], extra: Record<string, string> = env) =>
    spawnSync(SANDBOX_EXEC, ['-f', profiles[lead] ?? '', GH, ...args], {
      cwd: join(home, 'dev', lead),
      encoding: 'utf8',
      env: { ...process.env, HOME: home, ...extra },
      timeout: 30_000,
    });

  it("runs gh's own pr view and a REST read of a listed repo, sending the owner credential upstream", () => {
    rmSync(seenFile, { force: true });
    const view = gh('riverbend', ['pr', 'view', '5', '-R', 'a/b', '--json', 'number,title']);
    expect(view.stderr).toBe('');
    expect(JSON.parse(view.stdout)).toEqual({ number: 5, title: 'Riverbend' });
    const rest = gh('riverbend', ['api', 'repos/a/b/pulls/5']);
    expect(JSON.parse(rest.stdout)).toEqual({ answered: '/repos/a/b/pulls/5' });
    expect(seen().map((s) => s.authorization)).toEqual([
      `token ${credential}`,
      `token ${credential}`,
    ]);
    const token = readFileSync(join(gitProxyLeadDir(home, 'riverbend'), 'token'), 'utf8');
    expect(env.GH_TOKEN).toBe(token);
  }, 60_000);

  it('gets the proxy refusal for an unlisted repo, with nothing sent upstream', () => {
    rmSync(seenFile, { force: true });
    const r = gh('riverbend', ['api', 'repos/other/x']);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('other/x is not in the lead');
    expect(seen()).toEqual([]);
  }, 60_000);

  it("passes the --check rows: gh reaches the proxy, and the other lead's connect is EPERM", () => {
    const own = ghRows(profiles.riverbend ?? '', home, true, socket, env);
    const other = ghRows(profiles.saltmarsh ?? '', home, false, socket, {});
    expect(own.map((r) => [r.ok, r.says])).toEqual([
      [true, expect.stringContaining('gets the proxy')],
    ]);
    expect(other.map((r) => [r.ok, r.says])).toEqual([
      [true, expect.stringContaining('EPERM inside')],
    ]);
  }, 60_000);
});
