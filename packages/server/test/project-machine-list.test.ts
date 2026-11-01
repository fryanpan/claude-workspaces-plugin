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
  parseMachines,
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
});
