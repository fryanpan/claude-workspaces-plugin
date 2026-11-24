/**
 * A project name that maps onto a GitHub environment or Fly app something
 * else owns is refused (24 Nov wall re-review, L1). Nothing here calls Fly
 * or GitHub.
 */
import { describe, expect, it } from 'bun:test';
import { targets } from '../../../infra/project-machine/ci-tokens.ts';
import { parseMachines } from '../../../infra/project-machine/machines.ts';
import { WALL_APPS } from '../../../infra/project-machine/network-wall-plan.ts';
import { reservedProject } from '../../../infra/project-machine/reserved-names.ts';

const list = (machines: unknown) => JSON.stringify({ machines });

describe('L1: a project name may not map onto a reserved environment or app', () => {
  it('parseMachines refuses org, org-read, appkit-staging and any walltest- name', () => {
    for (const project of ['org', 'org-read', 'appkit-staging', 'walltest-harborlight']) {
      expect(() => parseMachines(list([{ project }]))).toThrow(project);
    }
    expect(() => parseMachines(list([{ project: 'orgs' }, { project: 'walltest' }]))).not.toThrow();
  });

  it('the reserved list covers every environment the CI tokens use and every wall-test app', () => {
    const own = targets([]).map((t) => t.environment);
    for (const env of [...own, 'fly-org', 'fly-org-read'])
      expect(reservedProject(env.replace(/^fly-/, ''))).not.toBeNull();
    for (const a of WALL_APPS) expect(reservedProject(a.app.replace(/^cw-/, ''))).not.toBeNull();
    expect(reservedProject('harborlight')).toBeNull();
  });
});
