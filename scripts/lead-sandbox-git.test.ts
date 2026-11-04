/**
 * A walled lead cannot write its projects' git settings, but a hooks folder
 * named by `core.hooksPath` that sits inside a project is ordinary files the
 * lead writes, and the owner's next commit runs them. So the launcher refuses
 * to wall a lead whose project has one. Real git, on throwaway repos.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitHooksPath, hooksPathRefusal } from './lead-sandbox-git.ts';
import { main } from './lead-sandbox.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'lead-sandbox-git-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
function repo(name: string, hooksPath?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir, env });
  if (hooksPath) execFileSync('git', ['config', 'core.hooksPath', hooksPath], { cwd: dir, env });
  return dir;
}
const realpath = (p: string) => realpathSync(p);
const readHooks = (p: string) => gitHooksPath(p, env);

describe('a hooks folder inside a walled project', () => {
  it('reads core.hooksPath as git in the project reads it', () => {
    expect(readHooks(repo('plain'))).toBeNull();
    expect(readHooks(repo('relative', '.githooks'))).toBe('.githooks');
  });

  it('refuses a relative one, which is inside every worktree it runs in', () => {
    const p = repo('harborlight', '.githooks');
    expect(hooksPathRefusal([p], readHooks, realpath)).toContain('.githooks');
  });

  it('refuses an absolute one inside the project, by either spelling', () => {
    const p = repo('riverbend');
    const link = join(root, 'link-to-riverbend');
    symlinkSync(p, link);
    execFileSync('git', ['config', 'core.hooksPath', join(link, 'hooks')], { cwd: p, env });
    expect(hooksPathRefusal([p], readHooks, realpath)).toContain('riverbend');
  });

  it('walls a project with no hooks folder, or one outside every project (the control)', () => {
    const outside = join(root, 'owner-hooks');
    mkdirSync(outside);
    expect(hooksPathRefusal([repo('saltmarsh')], readHooks, realpath)).toBeNull();
    expect(hooksPathRefusal([repo('alice', outside)], readHooks, realpath)).toBeNull();
  });

  it('runs its git with xcrun_nocache, whatever env it was given', () => {
    // A `git` that prints the variable as the hooks path, first on PATH.
    const bin = join(root, 'fake-bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'git'), '#!/bin/sh\necho "nocache-$xcrun_nocache"\n', { mode: 0o755 });
    const { xcrun_nocache: _drop, ...given } = env;
    expect(gitHooksPath(root, { ...given, PATH: `${bin}:/usr/bin:/bin` })).toBe('nocache-1');
  });

  it('sets xcrun_nocache for the whole launcher before anything runs', () => {
    Reflect.deleteProperty(process.env, 'xcrun_nocache');
    main([], { platform: 'linux', say: () => {} } as unknown as Parameters<typeof main>[1]);
    expect(process.env.xcrun_nocache).toBe('1');
  });

  it('stops the launch before the lead starts', () => {
    const p = repo('bob', '.githooks');
    const config = join(root, 'config.json');
    writeFileSync(config, JSON.stringify({ leads: [{ name: 'bob-lead', projects: [p] }] }));
    const said: string[] = [];
    let spawned = 0;
    const code = main(
      [
        '--config',
        config,
        '--profiles',
        join(root, 'profiles'),
        '--lead',
        'bob-lead',
        '--',
        'claude',
      ],
      {
        platform: 'darwin',
        say: (line) => said.push(line),
        readToken: () => null,
        leadTools: () => ({}),
        registerRoots: () => null,
        hooksPathOf: readHooks,
        spawn: () => {
          spawned++;
          return 0;
        },
      },
    );
    expect(code).toBe(2);
    expect(spawned).toBe(0);
    expect(said.join('\n')).toContain('core.hooksPath');
  });
});
