/**
 * What a walled lead must not write because something outside the wall reads
 * or runs it: the server's state under `~/.claude`, the temp names the
 * settings are replaced through, and the files in its projects' git folders
 * that make git run a command. Runs the generated profile under the real
 * `/usr/bin/sandbox-exec` against throwaway folders, and skips, saying so,
 * where there is none (Linux CI).
 */
import { execFileSync, spawnSync } from 'node:child_process';
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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type Machine, SANDBOX_EXEC, buildProfile, parseConfig } from './lead-sandbox-lib.ts';

const HAVE_SANDBOX = existsSync(SANDBOX_EXEC);
if (!HAVE_SANDBOX)
  console.warn(`lead-sandbox-state: ${SANDBOX_EXEC} is missing, so these cases skip.`);

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  });
}

describe.skipIf(!HAVE_SANDBOX)('what the server reads, under the real sandbox-exec', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lead-sandbox-state-')));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const twin = join(root, 'twin');
  const harborlight = join(home, 'dev', 'harborlight');
  const claudeDir = join(home, '.claude');
  const slot = join(claudeDir, 'claude-workspaces');
  for (const d of [
    harborlight,
    join(home, 'Library'),
    join(twin, '.claude', 'claude-workspaces', 'board-sync'),
    join(twin, '.claude', 'live-feedback'),
  ])
    mkdirSync(d, { recursive: true });
  // `~/.claude` links onto the data volume, as on the owner's Mac.
  symlinkSync(join(twin, '.claude'), claudeDir);
  writeFileSync(join(slot, 'server.json'), '{"port":8787}\n');
  writeFileSync(join(slot, 'board-sync', 'riverbend.json'), '{"token":"not-a-real-token"}\n');
  git(harborlight, 'init', '-q', '-b', 'main');
  writeFileSync(join(harborlight, 'README.md'), 'harborlight\n');
  git(harborlight, 'add', 'README.md');
  git(harborlight, 'commit', '-q', '-m', 'first');
  const configBefore = readFileSync(join(harborlight, '.git', 'config'), 'utf8');

  const m: Machine = {
    home,
    uid: 99999,
    realpath: (p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    },
  };
  const parsed = parseConfig(
    { leads: [{ name: 'harborlight-lead', projects: [harborlight] }] },
    home,
  );
  if (!parsed.ok) throw new Error(parsed.error);
  const lead = parsed.config.leads[0];
  if (!lead) throw new Error('fixture has no lead');
  const profileFile = join(root, 'harborlight-lead.sb');
  writeFileSync(profileFile, buildProfile(lead, parsed.config, m, [profileFile]));

  const sh = (script: string) =>
    spawnSync(SANDBOX_EXEC, ['-f', profileFile, '/bin/sh', '-c', script], {
      cwd: harborlight,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
    });

  it('reads the discovery file, and cannot replace it, link it or pipe it', () => {
    expect(sh(`cat '${slot}/server.json'`).stdout).toBe('{"port":8787}\n'); // the control
    for (const plant of [
      `echo '{"port":1}' > '${slot}/server.json'`,
      `rm '${slot}/server.json'`,
      `mkfifo '${slot}/next.json'`,
      `ln -s /etc/hosts '${slot}/link.json'`,
      `echo x > '${twin}/.claude/live-feedback/server.json'`,
      `mv '${slot}' '${harborlight}/moved'`,
    ])
      expect(sh(plant).status, plant).not.toBe(0);
    expect(readFileSync(join(slot, 'server.json'), 'utf8')).toBe('{"port":8787}\n');
    expect(existsSync(join(slot, 'next.json'))).toBe(false);
  });

  it("cannot read board-sync's state, which holds its token", () => {
    expect(sh(`cat '${slot}/board-sync/riverbend.json'`).status).not.toBe(0);
    expect(sh(`ls '${twin}/.claude/claude-workspaces/board-sync'`).status).not.toBe(0);
  });

  it('cannot plant a link at a name the settings are replaced through', () => {
    for (const name of ['.settings-1-2.cw-tmp', '.settings.json.0123abcd.tmp'])
      expect(sh(`ln -s /etc/hosts '${claudeDir}/${name}'`).status, name).not.toBe(0);
    expect(sh(`echo h >> '${claudeDir}/history.jsonl'`).status).toBe(0); // the control
  });

  it('commits in its project, and cannot write what makes git run a command', () => {
    expect(
      sh(
        'echo more >> README.md && git -c user.name=T -c user.email=t@example.invalid commit -qam second',
      ).status,
    ).toBe(0); // the control
    for (const plant of [
      'git config core.hooksPath /tmp',
      "echo '[core]' >> .git/config",
      'echo x > .git/hooks/post-checkout',
      'mkdir -p .git/info && echo "* filter=x" > .git/info/attributes',
      'echo x > .git/config.worktree',
    ])
      expect(sh(plant).status, plant).not.toBe(0);
    expect(readFileSync(join(harborlight, '.git', 'config'), 'utf8')).toBe(configBefore);
    expect(existsSync(join(harborlight, '.git', 'hooks', 'post-checkout'))).toBe(false);
  });
});
