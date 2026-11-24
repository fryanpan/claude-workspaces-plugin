/**
 * A push repo is one project's unless both entries declare the share, in
 * machines.json and on the daily wall (24 Nov wall re-review, L3). Nothing
 * here calls Fly or GitHub.
 */
import { describe, expect, it } from 'bun:test';
import { parseMachines } from '../../../infra/project-machine/machines.ts';
import { pushOverlapRows } from '../../../infra/project-machine/wall-push-overlap.ts';

const list = (machines: unknown) => JSON.stringify({ machines });
const failing = (rows: Array<{ check: string; answer: string; ok: boolean }>) =>
  rows.filter((r) => !r.ok).map((r) => `${r.check}: ${r.answer}`);

describe('L3: a push repo is one project’s unless both declare the share', () => {
  it('parseMachines refuses two projects on one push repo', () => {
    expect(() =>
      parseMachines(
        list([
          { project: 'harborlight', pushRepos: ['alice/shared'] },
          { project: 'riverbend', pushRepos: ['alice/shared'] },
        ]),
      ),
    ).toThrow('alice/shared');
    expect(() =>
      parseMachines(
        list([
          { project: 'harborlight', pushRepos: ['alice/shared'], sharePushRepos: ['alice/shared'] },
          { project: 'riverbend', pushRepos: ['alice/shared'] },
        ]),
      ),
    ).toThrow('alice/shared');
  });

  it('accepts the share when both entries declare it, and a share must be a push repo', () => {
    const both = parseMachines(
      list([
        { project: 'harborlight', pushRepos: ['alice/shared'], sharePushRepos: ['alice/shared'] },
        { project: 'riverbend', pushRepos: ['alice/shared'], sharePushRepos: ['alice/shared'] },
      ]),
    );
    expect(both.map((m) => m.sharePushRepos)).toEqual([['alice/shared'], ['alice/shared']]);
    expect(() =>
      parseMachines(
        list([{ project: 'harborlight', pushRepos: ['alice/a'], sharePushRepos: ['alice/b'] }]),
      ),
    ).toThrow('sharePushRepos');
  });

  it('the wall fails a repo two machines push to that machines.json does not share', () => {
    const rules = (repo: string) => ({
      state: 'ok' as const,
      rules: [{ board: 'w-1', repo, approval: true }],
    });
    const pushes = new Map([
      ['harborlight', rules('alice/shared')],
      ['riverbend', rules('alice/shared')],
      ['saltmarsh', rules('alice/saltmarsh')],
    ]);
    const machines = [
      { project: 'harborlight', tunnel: 'named' as const },
      { project: 'riverbend', tunnel: 'named' as const },
      { project: 'saltmarsh', tunnel: 'named' as const },
    ];
    expect(failing(pushOverlapRows(machines, pushes))).toEqual([
      'push repo is this project’s alone: alice/shared, also pushed to by riverbend',
      'push repo is this project’s alone: alice/shared, also pushed to by harborlight',
    ]);
    const shared = machines.map((m) =>
      m.project === 'saltmarsh' ? m : { ...m, sharePushRepos: ['alice/shared'] },
    );
    expect(failing(pushOverlapRows(shared, pushes))).toEqual([]);
    expect(pushOverlapRows(shared, pushes).filter((r) => r.project === 'saltmarsh')).toEqual([
      { project: 'saltmarsh', check: 'push repo is this project’s alone', answer: 'yes', ok: true },
    ]);
  });
});
