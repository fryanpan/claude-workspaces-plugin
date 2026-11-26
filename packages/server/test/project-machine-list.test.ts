/**
 * The committed list of project machines CI deploys
 * (`infra/project-machine/machines.ts`): what a valid list is, the
 * `machine:deploy` arguments each entry becomes, and that the committed file
 * itself parses. Nothing here runs a deploy.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  MACHINES_FILE,
  deployArgs,
  listedArgs,
  matrixLine,
  parseMachines,
  provisionFlags,
  selected,
} from '../../../infra/project-machine/machines.ts';

const list = (machines: unknown) => JSON.stringify({ machines });

describe('the machine list', () => {
  it('the committed file parses', () => {
    expect(Array.isArray(parseMachines(readFileSync(MACHINES_FILE, 'utf8')))).toBe(true);
  });

  it('defaults a machine to a named tunnel and turns each entry into deploy arguments', () => {
    const [river, salt] = parseMachines(
      list([{ project: 'riverbend' }, { project: 'saltmarsh', memory: 2048, leadBoard: 'w-salt' }]),
    );
    expect(deployArgs(river as never, 'abc123', false)).toEqual([
      '--project',
      'riverbend',
      '--tunnel',
      'named',
      '--ref',
      'abc123',
    ]);
    expect(deployArgs(salt as never, 'abc123', true)).toEqual([
      '--project',
      'saltmarsh',
      '--tunnel',
      'named',
      '--ref',
      'abc123',
      '--memory',
      '2048',
      '--lead-board',
      'w-salt',
      '--dry-run',
    ]);
  });

  it('refuses a malformed entry before any deploy runs', () => {
    expect(() => parseMachines('{}')).toThrow('no "machines" list');
    expect(() => parseMachines(list([{ project: 'Riverbend; rm' }]))).toThrow('no valid project');
    expect(() => parseMachines(list([{ project: 'riverbend' }, { project: 'riverbend' }]))).toThrow(
      'twice',
    );
    expect(() => parseMachines(list([{ project: 'riverbend', tunnel: 'wide' }]))).toThrow('tunnel');
    expect(() => parseMachines(list([{ project: 'riverbend', memory: '2g' }]))).toThrow('memory');
  });

  it('gives fly.yml one job per project, and a job deploys its own project alone', () => {
    const machines = parseMachines(list([{ project: 'riverbend' }, { project: 'saltmarsh' }]));
    expect(matrixLine(machines)).toBe('matrix=["riverbend","saltmarsh"]');
    expect(selected(machines, 'saltmarsh').map((m) => m.project)).toEqual(['saltmarsh']);
    expect(selected(machines, undefined)).toHaveLength(2);
    expect(() => selected(machines, 'harborlight')).toThrow('no project harborlight');
    // CI's jobs hold no key to the Terraform state, so they read no outputs.
    expect(deployArgs(machines[0] as never, 'abc123', false, true).at(-1)).toBe(
      '--no-terraform-outputs',
    );
  });
});

describe('push repos come from the committed list alone', () => {
  it('a machine pushes to the repos machines.json lists, each its own --push-repo', () => {
    const [river, salt] = parseMachines(
      list([
        { project: 'riverbend', pushRepos: ['harborlight/riverbend', 'harborlight/saltmarsh'] },
        { project: 'saltmarsh' },
      ]),
    );
    expect(river?.pushRepos).toEqual(['harborlight/riverbend', 'harborlight/saltmarsh']);
    expect(deployArgs(river as never, 'abc123', false, true)).toEqual([
      '--project',
      'riverbend',
      '--tunnel',
      'named',
      '--ref',
      'abc123',
      '--push-repo',
      'harborlight/riverbend',
      '--push-repo',
      'harborlight/saltmarsh',
      '--no-terraform-outputs',
    ]);
    // A machine that lists none gets no push key at all.
    expect(deployArgs(salt as never, 'abc123', false)).not.toContain('--push-repo');
  });

  it('refuses a push repo that is not owner/name, a repeat, or too many', () => {
    const one = (pushRepos: unknown) => parseMachines(list([{ project: 'riverbend', pushRepos }]));
    expect(() => one('harborlight/riverbend')).toThrow('pushRepos');
    expect(() => one(['harborlight/..'])).toThrow('pushRepos');
    expect(() => one(['harborlight/riverbend', 'harborlight/riverbend'])).toThrow('pushRepos');
    expect(() => one([])).toThrow('pushRepos');
    expect(() => one(Array.from({ length: 21 }, (_, i) => `harborlight/r${i}`))).toThrow(
      'pushRepos',
    );
  });

  it('a dispatch cannot name a repo: --push-repo is not a provisioning flag', () => {
    expect(() => provisionFlags(['--', '--push-repo', 'harborlight/riverbend'])).toThrow(
      'not a provisioning flag',
    );
  });
});

describe('the flags fly-provision.yml passes through', () => {
  it('passes the two refreshes, and nothing before the --', () => {
    expect(provisionFlags(['deploy', '--project', 'riverbend'])).toEqual([]);
    expect(
      provisionFlags(['deploy', '--', '--refresh-push-keys', '--refresh-tunnel-token']),
    ).toEqual(['--refresh-push-keys', '--refresh-tunnel-token']);
  });

  it('refuses any other flag', () => {
    expect(() => provisionFlags(['--', '--lead-board', 'w-x'])).toThrow('not a provisioning flag');
    expect(() => provisionFlags(['--', ''])).toThrow('an empty argument');
  });
});

describe('a hand run of machine:deploy for a listed project', () => {
  const machines = parseMachines(
    list([
      { project: 'riverbend', memory: 512, seedBoard: 'Riverbend sign-in check' },
      { project: 'saltmarsh', leadBoard: 'w-salt', pushRepos: ['alice/salt', 'alice/marsh'] },
    ]),
  );

  it('takes the flags it left out from the entry', () => {
    const { args, added } = listedArgs(
      ['--project', 'riverbend', '--ref', 'origin/main'],
      machines,
    );
    expect(args).toEqual([
      '--project',
      'riverbend',
      '--ref',
      'origin/main',
      '--tunnel',
      'named',
      '--memory',
      '512',
      '--seed-board',
      'Riverbend sign-in check',
    ]);
    expect(added).toEqual([
      '--tunnel named',
      '--memory 512',
      '--seed-board Riverbend sign-in check',
    ]);
    expect(listedArgs(['--project', 'saltmarsh'], machines).added).toEqual([
      '--tunnel named',
      '--lead-board w-salt',
      '--push-repo alice/salt',
      '--push-repo alice/marsh',
    ]);
  });

  it('matches what machines.ts deploy passes, so that run is unchanged', () => {
    for (const m of machines) {
      const full = deployArgs(m, 'abc123', true);
      expect(listedArgs(full, machines)).toEqual({ args: full, added: [] });
    }
  });

  it('refuses a flag that differs from the entry, naming machines.ts deploy', () => {
    const run =
      (...extra: string[]) =>
      () =>
        listedArgs(['--project', 'riverbend', ...extra], machines);
    expect(run('--tunnel', 'quick')).toThrow(
      'machines.json lists riverbend with --tunnel named: change machines.json, or run machines.ts deploy --project riverbend',
    );
    expect(run('--seed-board', 'Harborlight')).toThrow('--seed-board Riverbend sign-in check');
    expect(run('--lead-board', 'w-river')).toThrow('with no --lead-board');
    expect(() =>
      listedArgs(['--project', 'saltmarsh', '--push-repo', 'alice/salt'], machines),
    ).toThrow('--push-repo alice/salt --push-repo alice/marsh');
    expect(() =>
      listedArgs(
        ['--project', 'saltmarsh', '--push-repo', 'alice/salt', '--push-repo', 'alice/salt'],
        machines,
      ),
    ).toThrow('--push-repo alice/salt --push-repo alice/marsh');
  });

  it('leaves an unlisted project as it was', () => {
    const args = ['--project', 'harborlight', '--tunnel', 'quick'];
    expect(listedArgs(args, machines)).toEqual({ args, added: [] });
  });
});
