/**
 * Which boards' sockets the collab core serves (`collab-core-switch.ts`).
 *
 * Two settings: a per-board one, kept in the data folder, and a server-wide
 * one read at boot. A board takes the core path only when both are on, so
 * turning the server-wide one off returns every board to the current code on
 * the next start without touching any board's own setting.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CollabCoreSwitch,
  collabCoreBoardsPath,
  parseCollabCoreDefault,
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

describe('parseCollabCoreDefault', () => {
  it('is off unless the value says on', () => {
    expect(parseCollabCoreDefault(undefined)).toBe(false);
    expect(parseCollabCoreDefault('')).toBe(false);
    expect(parseCollabCoreDefault('off')).toBe(false);
    expect(parseCollabCoreDefault('0')).toBe(false);
    expect(parseCollabCoreDefault('maybe')).toBe(false);
    expect(parseCollabCoreDefault('on')).toBe(true);
    expect(parseCollabCoreDefault(' ON ')).toBe(true);
    expect(parseCollabCoreDefault('1')).toBe(true);
    expect(parseCollabCoreDefault('true')).toBe(true);
  });
});

describe('CollabCoreSwitch', () => {
  it('starts with every board off', () => {
    const sw = new CollabCoreSwitch({ dataDir: fresh(), serverWide: true });
    expect(sw.boardOn('harborlight')).toBe(false);
    expect(sw.usesCore('harborlight')).toBe(false);
  });

  it('takes the core path only when the board and the server-wide setting are both on', () => {
    const dataDir = fresh();
    new CollabCoreSwitch({ dataDir, serverWide: true }).set('harborlight', true);
    const on = new CollabCoreSwitch({ dataDir, serverWide: true });
    expect(on.usesCore('harborlight')).toBe(true);
    expect(on.usesCore('riverbend')).toBe(false);
    // Server-wide off: the board keeps its setting and takes the current code.
    const off = new CollabCoreSwitch({ dataDir, serverWide: false });
    expect(off.boardOn('harborlight')).toBe(true);
    expect(off.usesCore('harborlight')).toBe(false);
  });

  it('keeps a board’s setting across a restart and turns it off again', () => {
    const dataDir = fresh();
    const sw = new CollabCoreSwitch({ dataDir, serverWide: true });
    sw.set('harborlight', true);
    sw.set('saltmarsh', true);
    sw.set('saltmarsh', false);
    const again = new CollabCoreSwitch({ dataDir, serverWide: true });
    expect(again.boardsOn()).toEqual(['harborlight']);
    expect(JSON.parse(readFileSync(collabCoreBoardsPath(dataDir), 'utf8'))).toEqual({
      boards: ['harborlight'],
    });
  });

  it('reads an unreadable or malformed file as every board off', () => {
    const dataDir = fresh();
    writeFileSync(collabCoreBoardsPath(dataDir), '{not json');
    expect(new CollabCoreSwitch({ dataDir, serverWide: true }).boardsOn()).toEqual([]);
    writeFileSync(collabCoreBoardsPath(dataDir), JSON.stringify({ boards: ['ok', 7, '../x'] }));
    expect(new CollabCoreSwitch({ dataDir, serverWide: true }).boardsOn()).toEqual(['ok']);
  });

  it('refuses a board id that is not one', () => {
    const sw = new CollabCoreSwitch({ dataDir: fresh(), serverWide: true });
    expect(() => sw.set('../etc', true)).toThrow(/board id/);
  });
});
