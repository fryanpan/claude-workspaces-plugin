/**
 * A board move's calls on a project machine (`flyTarget` in
 * `infra/project-machine/move-board.ts`): which commands go to the machine,
 * in which order, and that the machine is released even when the import
 * fails. `fly` is a stand-in that records every call; nothing leaves.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MoveOps, flyTarget } from '../../../infra/project-machine/move-board.ts';
import { moveCommands } from '../src/provisioning/move-steps.ts';

const APP = 'cw-harborlight';
const BOARD = 'w-board1';
const tmp = mkdtempSync(join(tmpdir(), 'fly-target-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function recordingOps(opts: { failImport?: boolean } = {}) {
  const calls: string[] = [];
  const c = moveCommands(BOARD);
  const ops: MoveOps = {
    flyOk: (args) => {
      calls.push(`fly ${args.join(' ')}`);
      return '';
    },
    onMachine: (app, command) => {
      expect(app).toBe(APP);
      calls.push(`machine ${command}`);
      if (opts.failImport && command === c.importBundle) throw new Error('import refused');
      if (command === c.serving) return '200';
      return '{"holds":false}';
    },
    privateStage: () => ({ dir: tmp, share: () => {}, done: () => calls.push('stage done') }),
    machines: () => [{ id: 'm1', state: 'started' }],
    pack: (_, tgz) => writeFileSync(tgz, 'bundle'),
    sleep: async () => {},
  };
  return { ops, calls, c };
}

describe('flyTarget', () => {
  it('asks the machine whether it holds the board with the holds command', async () => {
    const { ops, calls, c } = recordingOps();
    expect(await flyTarget(APP, ops).holds(BOARD)).toBe(false);
    expect(calls).toEqual([`machine ${c.holds}`]);
  });

  it('uploads, holds services off, imports, then releases and waits for the server', async () => {
    const { ops, calls, c } = recordingOps();
    await flyTarget(APP, ops).importBundle(tmp, BOARD);
    const tgz = join(tmp, 'bundle.tgz');
    expect(calls).toEqual([
      `machine ${c.prepare}`,
      `fly ssh sftp put ${tgz} ${c.upload} --app ${APP}`,
      `machine ${c.holdOff}`,
      `fly machine restart m1 --app ${APP}`,
      `machine ${c.importBundle}`,
      `machine ${c.release}`,
      `fly machine restart m1 --app ${APP}`,
      `machine ${c.serving}`,
      'stage done',
    ]);
  });

  it('releases the machine and removes the upload when the import fails', async () => {
    const { ops, calls, c } = recordingOps({ failImport: true });
    await expect(flyTarget(APP, ops).importBundle(tmp, BOARD)).rejects.toThrow('import refused');
    const after = calls.slice(calls.indexOf(`machine ${c.importBundle}`) + 1);
    expect(after).toEqual([
      `machine ${c.release}`,
      `fly machine restart m1 --app ${APP}`,
      `machine ${c.serving}`,
      'stage done',
    ]);
  });
});
