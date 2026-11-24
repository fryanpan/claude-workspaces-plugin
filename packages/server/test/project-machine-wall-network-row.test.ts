/**
 * The Fly network row counts every app on a project's network, not only the
 * other projects (24 Nov wall re-review, L2). Nothing here calls Fly.
 */
import { describe, expect, it } from 'bun:test';
import { flyRows } from '../../../infra/project-machine/wall-drift.ts';

const failing = (rows: Array<{ check: string; answer: string; ok: boolean }>) =>
  rows.filter((r) => !r.ok).map((r) => `${r.check}: ${r.answer}`);

describe('L2: the Fly network row counts every other app on the network', () => {
  it('fails a project whose network holds an app machines.json does not list', () => {
    const view = {
      apps: [
        { Name: 'cw-riverbend', Network: 'cw-riverbend' },
        { Name: 'saltmarsh-scratch', Network: 'cw-riverbend' },
      ],
      ips: {},
      machines: {},
    };
    expect(failing(flyRows(['riverbend'], view))).toEqual([
      'Fly network: cw-riverbend, shared with saltmarsh-scratch',
    ]);
  });
});
