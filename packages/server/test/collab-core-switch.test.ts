/**
 * Which boards' sockets the collab core serves (`collab-core-switch.ts`).
 *
 * Two settings: a per-board one and a server-wide one, both kept in the data
 * folder, with `CW_COLLAB_CORE` fixing the server-wide one when it is set. A
 * board takes the core path only when both are on, so turning the
 * server-wide one off returns every board to the current code without
 * touching any board's own setting.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CollabCoreFixedError,
  CollabCoreSwitch,
  collabCoreBoardsPath,
  collabCoreServerPath,
  parseCollabCoreDefault,
  parseCollabCoreEnv,
} from '../src/collab-core-switch.ts';

const dirs: string[] = [];
const fresh = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'collab-core-switch-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseCollabCoreEnv', () => {
  it('leaves the setting to the runtime switch when unset, else fixes it', () => {
    expect(parseCollabCoreEnv(undefined)).toBe(undefined);
    expect(parseCollabCoreEnv('')).toBe(undefined);
    expect(parseCollabCoreEnv('  ')).toBe(undefined);
    expect(parseCollabCoreEnv('off')).toBe(false);
    expect(parseCollabCoreEnv('0')).toBe(false);
    expect(parseCollabCoreEnv('maybe')).toBe(false);
    expect(parseCollabCoreEnv('on')).toBe(true);
    expect(parseCollabCoreEnv(' ON ')).toBe(true);
    expect(parseCollabCoreEnv('1')).toBe(true);
    expect(parseCollabCoreEnv('true')).toBe(true);
  });
});

describe('the runtime server-wide switch', () => {
  it('is off by default, and on once set, across a restart', () => {
    const dataDir = fresh();
    const sw = new CollabCoreSwitch({ dataDir });
    sw.set('harborlight', true);
    expect(sw.serverWide).toBe(false);
    expect(sw.usesCore('harborlight')).toBe(false);
    sw.setServerWide(true);
    expect(sw.usesCore('harborlight')).toBe(true);
    const again = new CollabCoreSwitch({ dataDir });
    expect(again.serverWide).toBe(true);
    expect(again.usesCore('harborlight')).toBe(true);
    again.setServerWide(false);
    expect(new CollabCoreSwitch({ dataDir }).serverWide).toBe(false);
  });

  it('loses to an environment that fixes it off, and refuses to turn on', () => {
    const dataDir = fresh();
    const runtime = new CollabCoreSwitch({ dataDir });
    runtime.set('harborlight', true);
    runtime.setServerWide(true);
    // The file says on; the environment says off, and wins.
    const fixedOff = new CollabCoreSwitch({ dataDir, fixed: false });
    expect(fixedOff.serverWide).toBe(false);
    expect(fixedOff.usesCore('harborlight')).toBe(false);
    expect(() => fixedOff.setServerWide(true)).toThrow(CollabCoreFixedError);
    // Asking for what the environment already says is not a change.
    fixedOff.setServerWide(false);
    expect(JSON.parse(readFileSync(collabCoreServerPath(dataDir), 'utf8'))).toEqual({ on: true });
  });

  it('reads a malformed file as off', () => {
    const dataDir = fresh();
    writeFileSync(collabCoreServerPath(dataDir), '{not json');
    expect(new CollabCoreSwitch({ dataDir }).serverWide).toBe(false);
    writeFileSync(collabCoreServerPath(dataDir), JSON.stringify({ on: 'yes' }));
    expect(new CollabCoreSwitch({ dataDir }).serverWide).toBe(false);
  });

  it('tells every board switched on, and no other, when it moves', () => {
    const sw = new CollabCoreSwitch({ dataDir: fresh() });
    sw.set('harborlight', true);
    sw.set('riverbend', true);
    const told: string[] = [];
    sw.onChange((ws) => told.push(ws));
    sw.setServerWide(true);
    expect(told).toEqual(['harborlight', 'riverbend']);
    sw.setServerWide(true);
    expect(told).toHaveLength(2);
  });
});

describe('CollabCoreSwitch', () => {
  it('starts with every board off', () => {
    const sw = new CollabCoreSwitch({ dataDir: fresh(), fixed: true });
    expect(sw.boardOn('harborlight')).toBe(false);
    expect(sw.usesCore('harborlight')).toBe(false);
  });

  it('takes the core path only when the board and the server-wide setting are both on', () => {
    const dataDir = fresh();
    new CollabCoreSwitch({ dataDir, fixed: true }).set('harborlight', true);
    const on = new CollabCoreSwitch({ dataDir, fixed: true });
    expect(on.usesCore('harborlight')).toBe(true);
    expect(on.usesCore('riverbend')).toBe(false);
    // Server-wide off: the board keeps its setting and takes the current code.
    const off = new CollabCoreSwitch({ dataDir, fixed: false });
    expect(off.boardOn('harborlight')).toBe(true);
    expect(off.usesCore('harborlight')).toBe(false);
  });

  it('keeps a board’s setting across a restart and turns it off again', () => {
    const dataDir = fresh();
    const sw = new CollabCoreSwitch({ dataDir, fixed: true });
    sw.set('harborlight', true);
    sw.set('saltmarsh', true);
    sw.set('saltmarsh', false);
    const again = new CollabCoreSwitch({ dataDir, fixed: true });
    expect(again.boardsOn()).toEqual(['harborlight']);
    expect(JSON.parse(readFileSync(collabCoreBoardsPath(dataDir), 'utf8'))).toEqual({
      boards: ['harborlight'],
    });
  });

  it('reads an unreadable or malformed file as every board off', () => {
    const dataDir = fresh();
    writeFileSync(collabCoreBoardsPath(dataDir), '{not json');
    expect(new CollabCoreSwitch({ dataDir, fixed: true }).boardsOn()).toEqual([]);
    writeFileSync(collabCoreBoardsPath(dataDir), JSON.stringify({ boards: ['ok', 7, '../x'] }));
    expect(new CollabCoreSwitch({ dataDir, fixed: true }).boardsOn()).toEqual(['ok']);
  });

  it('refuses a board id that is not one', () => {
    const sw = new CollabCoreSwitch({ dataDir: fresh(), fixed: true });
    expect(() => sw.set('../etc', true)).toThrow(/board id/);
  });
});

describe('CollabCoreSwitch.onChange', () => {
  it('tells a listener after each real change, and anyBoardOn follows', () => {
    const sw = new CollabCoreSwitch({ dataDir: fresh(), fixed: true });
    let told = 0;
    const off = sw.onChange(() => told++);
    expect(sw.anyBoardOn()).toBe(false);
    sw.set('harborlight', true);
    expect(told).toBe(1);
    expect(sw.anyBoardOn()).toBe(true);
    // Setting what is already set changes nothing and tells nobody.
    sw.set('harborlight', true);
    expect(told).toBe(1);
    off();
    sw.set('harborlight', false);
    expect(told).toBe(1);
    expect(sw.anyBoardOn()).toBe(false);
  });
});

describe('the default-on mode (CW_COLLAB_CORE_DEFAULT, the core-mode test runs)', () => {
  it('reads the variable as on only for on, 1 or true', () => {
    expect(parseCollabCoreDefault(undefined)).toBe(false);
    expect(parseCollabCoreDefault('')).toBe(false);
    expect(parseCollabCoreDefault('off')).toBe(false);
    expect(parseCollabCoreDefault(' On ')).toBe(true);
    expect(parseCollabCoreDefault('1')).toBe(true);
    expect(parseCollabCoreDefault('true')).toBe(true);
  });

  it('puts every board and the server-wide setting on, with nothing written', () => {
    const dataDir = fresh();
    const sw = new CollabCoreSwitch({ dataDir, defaultOn: true });
    expect(sw.serverWide).toBe(true);
    expect(sw.boardOn('harborlight')).toBe(true);
    expect(sw.usesCore('riverbend')).toBe(true);
    expect(sw.anyBoardOn()).toBe(true);
    // Not a board id, so never on.
    expect(sw.boardOn('../etc')).toBe(false);
  });

  it('still lets a board and the server-wide setting be turned off, across a restart', () => {
    const dataDir = fresh();
    const sw = new CollabCoreSwitch({ dataDir, defaultOn: true });
    const told: string[] = [];
    sw.onChange((ws) => told.push(ws));
    sw.set('saltmarsh', false);
    expect(sw.usesCore('saltmarsh')).toBe(false);
    expect(sw.usesCore('harborlight')).toBe(true);
    expect(told).toEqual(['saltmarsh']);
    const again = new CollabCoreSwitch({ dataDir, defaultOn: true });
    expect(again.usesCore('saltmarsh')).toBe(false);
    again.set('saltmarsh', true);
    expect(again.usesCore('saltmarsh')).toBe(true);
    again.setServerWide(false);
    const third = new CollabCoreSwitch({ dataDir, defaultOn: true });
    expect(third.serverWide).toBe(false);
    expect(third.usesCore('saltmarsh')).toBe(false);
  });

  it('tells every board on only by default when the server-wide setting flips', () => {
    // Under the default there is no list of boards that are on, so the
    // switch asks the server which boards exist. A board turned off hears
    // nothing: its path did not change.
    const sw = new CollabCoreSwitch({
      dataDir: fresh(),
      defaultOn: true,
      knownBoards: () => ['harborlight', 'riverbend', 'saltmarsh'],
    });
    sw.set('saltmarsh', false);
    const told: string[] = [];
    sw.onChange((ws) => told.push(ws));
    sw.setServerWide(false);
    expect(told.sort()).toEqual(['harborlight', 'riverbend']);
    told.length = 0;
    sw.setServerWide(true);
    expect(told.sort()).toEqual(['harborlight', 'riverbend']);
  });

  it('tells a board named on and on by default once each', () => {
    const sw = new CollabCoreSwitch({
      dataDir: fresh(),
      defaultOn: true,
      knownBoards: () => ['harborlight', 'riverbend'],
    });
    sw.set('harborlight', false);
    sw.set('harborlight', true);
    const told: string[] = [];
    sw.onChange((ws) => told.push(ws));
    sw.setServerWide(false);
    expect(told.sort()).toEqual(['harborlight', 'riverbend']);
  });

  it('loses to an environment that fixes the core off', () => {
    const sw = new CollabCoreSwitch({ dataDir: fresh(), defaultOn: true, fixed: false });
    expect(sw.boardOn('harborlight')).toBe(true);
    expect(sw.usesCore('harborlight')).toBe(false);
  });

  it('leaves the file in the shape the current code reads when no board is turned off', () => {
    const dataDir = fresh();
    const sw = new CollabCoreSwitch({ dataDir, defaultOn: true });
    // Already on by default: nothing to save.
    sw.set('harborlight', true);
    sw.set('riverbend', false);
    expect(JSON.parse(readFileSync(collabCoreBoardsPath(dataDir), 'utf8'))).toEqual({
      boards: [],
      off: ['riverbend'],
    });
    sw.set('riverbend', true);
    expect(JSON.parse(readFileSync(collabCoreBoardsPath(dataDir), 'utf8'))).toEqual({
      boards: ['riverbend'],
    });
  });
});
