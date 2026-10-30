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
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { leadWritesUnderClaude } from '../packages/core/src/lead-wall.ts';
import {
  type Machine,
  SANDBOX_EXEC,
  buildProfile,
  parseConfig,
  transcriptSlug,
} from './lead-sandbox-lib.ts';

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
    // The launcher makes it before the wall goes up (`writeProfile`).
    join(twin, '.claude', 'projects'),
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
  // A worktree made before the wall, as a lead's builders would have.
  git(harborlight, 'worktree', 'add', '-q', join('.claude', 'worktrees', 'w1'));
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

  // Seatbelt judges a rename by the two names it moves, never by the files
  // inside the folder moved, so a git folder built elsewhere and renamed into
  // place passed every rule on the files in it (probed by the review).
  const swapGitFolder =
    "cp -R .git newgit && printf '[core]\\n\\tfsmonitor = touch PWNED\\n' >> newgit/config && mv .git oldgit && mv newgit .git";

  it('cannot swap in a git folder, a pointer to one, or a common folder', () => {
    try {
      for (const plant of [
        swapGitFolder,
        'mkdir -p sub && printf "gitdir: /tmp\\n" > sub/.git',
        'echo /tmp > .git/commondir',
        'mv .git/hooks .git/hooks-old',
        'mv .git/info .git/info-old',
        'mv .git/worktrees/w1 .git/worktrees/w0',
        'echo /tmp > .git/worktrees/w1/commondir',
        'echo x > .git/worktrees/w1/config.worktree',
        'printf "gitdir: /tmp\\n" > .claude/worktrees/w1/.git',
      ])
        expect(sh(plant).status, plant).not.toBe(0);
      git(harborlight, 'status', '--short');
      expect(existsSync(join(harborlight, 'PWNED'))).toBe(false);
      expect(existsSync(join(harborlight, 'sub', '.git'))).toBe(false);
      expect(readFileSync(join(harborlight, '.git', 'config'), 'utf8')).toBe(configBefore);
    } finally {
      for (const d of ['newgit', 'sub'])
        rmSync(join(harborlight, d), { recursive: true, force: true });
    }
  });

  it("writes its own scratch folder, and no other project's", () => {
    // The server reads another project's scratch (a mock an unwalled session
    // attached), which is only safe while no walled lead can write there.
    const scratch = `/private/tmp/claude-${m.uid}`;
    const made = !existsSync(scratch);
    const own = join(scratch, transcriptSlug(harborlight));
    const ownWorktree = `${own}--claude-worktrees-walled-probe`;
    const other = join(scratch, '-walled-probe-riverbend');
    try {
      for (const d of [own, ownWorktree, other]) mkdirSync(d, { recursive: true });
      writeFileSync(join(other, 'mock.html'), '<p>riverbend</p>');
      expect(sh(`echo x > '${own}/mock.html' && echo x > '${ownWorktree}/mock.html'`).status).toBe(
        0,
      ); // the control
      for (const plant of [
        `echo x > '${other}/mock.html'`,
        `echo x > '${other}/new.html'`,
        `ln -s /etc/hosts '${other}/link.html'`,
        `mkfifo '${other}/pipe.html'`,
        `echo x > '/tmp/claude-${m.uid}/-walled-probe-riverbend/via-tmp.html'`,
        `mkdir '${scratch}/-walled-probe-saltmarsh'`,
        `mv '${other}' '${own}/taken'`,
      ])
        expect(sh(plant).status, plant).not.toBe(0);
      expect(readFileSync(join(other, 'mock.html'), 'utf8')).toBe('<p>riverbend</p>');
      expect(existsSync(join(scratch, '-walled-probe-saltmarsh'))).toBe(false);
    } finally {
      for (const d of [own, ownWorktree, other]) rmSync(d, { recursive: true, force: true });
      if (made) rmSync(scratch, { recursive: true, force: true });
    }
  });

  // The server refuses what a lead can write under ~/.claude and reads the
  // rest (`leadWritesUnderClaude`); the profile is built from the same lists.
  const ownSlug = transcriptSlug(harborlight);
  const otherSlug = transcriptSlug(join(home, 'dev', 'riverbend'));
  const underClaude: Array<[string, boolean]> = [
    [`projects/${otherSlug}/memory/MEMORY.md`, false],
    [`projects/${otherSlug}/session.jsonl`, false],
    [`projects/${ownSlug}/memory/MEMORY.md`, true],
    [`projects/${ownSlug}--claude-worktrees-wt/session.jsonl`, true],
    ['plans/plan.md', false],
    ['rules/rule.md', false],
    ['plugins/planted/run.sh', false],
    ['skills/planted/SKILL.md', false],
    ['CLAUDE.md', false],
    ['settings.local.json', false],
    ['claude-workspaces/server.json', false],
    ['history.jsonl', true],
    ['todos/todo.json', true],
  ];
  const writeUnder = (profile: string, rel: string) => {
    const path = join(claudeDir, rel);
    return spawnSync(
      SANDBOX_EXEC,
      ['-f', profile, '/bin/sh', '-c', `mkdir -p "$(dirname '${path}')" && echo x > '${path}'`],
      { cwd: harborlight, encoding: 'utf8' },
    ).status;
  };

  it('writes under ~/.claude exactly where the server says a lead can', () => {
    const slugs = new Set([ownSlug]);
    for (const [rel, writable] of underClaude) {
      expect(leadWritesUnderClaude(rel, slugs), `server: ${rel}`).toBe(writable);
      expect(writeUnder(profileFile, rel) === 0, `wall: ${rel}`).toBe(writable);
    }
  });

  it("writes another project's memory, the plans, rules or plugins once its rule is removed (the mutation control)", () => {
    const text = readFileSync(profileFile, 'utf8');
    for (const [drop, rel] of [
      [/\(subpath "[^"]*\/\.claude\/projects"\)/, `projects/${otherSlug}/memory/MEMORY.md`],
      [/\(subpath "[^"]*\/\.claude\/plans"\)/, 'plans/plan.md'],
      [/\(subpath "[^"]*\/\.claude\/rules"\)/, 'rules/rule.md'],
      [/\(subpath "[^"]*\/\.claude\/plugins"\)/, 'plugins/planted/run.sh'],
    ] as const) {
      const mutated = join(root, 'mutated.sb');
      writeFileSync(
        mutated,
        text
          .split('\n')
          .filter((l) => !drop.test(l))
          .join('\n'),
      );
      expect(writeUnder(mutated, rel), String(drop)).toBe(0);
    }
  });

  // Last, since it leaves the project's git folder swapped until it puts it back.
  it("swaps in a git folder that runs the owner's git, once the git rules are removed (the mutation control)", () => {
    const mutated = join(root, 'mutated-git.sb');
    writeFileSync(
      mutated,
      readFileSync(profileFile, 'utf8')
        .split('\n')
        .filter((l) => !l.endsWith('; git runs it outside the wall'))
        .join('\n'),
    );
    const swapped = spawnSync(SANDBOX_EXEC, ['-f', mutated, '/bin/sh', '-c', swapGitFolder], {
      cwd: harborlight,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
    });
    try {
      expect(swapped.status, swapped.stderr).toBe(0);
      git(harborlight, 'status', '--short');
      expect(existsSync(join(harborlight, 'PWNED'))).toBe(true);
    } finally {
      rmSync(join(harborlight, '.git'), { recursive: true, force: true });
      renameSync(join(harborlight, 'oldgit'), join(harborlight, '.git'));
      rmSync(join(harborlight, 'PWNED'), { force: true });
    }
  });
});
