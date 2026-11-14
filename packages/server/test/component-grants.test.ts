/**
 * The owner's component folder grants: a granted folder covers the files
 * under it and nothing beside it, a grant survives a restart in a mode-600
 * file, and a file that cannot be read grants nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComponentGrants } from '../src/component-grants.ts';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'component-grants-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('component folder grants', () => {
  it('cover the files under a granted folder and nothing beside it', () => {
    const grants = new ComponentGrants(dir);
    expect(grants.covers('/r/harborlight/map/index.ts')).toBe(false);
    const before = grants.version;
    grants.grant('/r/harborlight/map', 'Alice');
    expect(grants.version).not.toBe(before);
    expect(grants.covers('/r/harborlight/map/index.ts')).toBe(true);
    expect(grants.covers('/r/harborlight/map/deep/pin.tsx')).toBe(true);
    expect(grants.covers('/r/harborlight/mapper/index.ts')).toBe(false);
    expect(grants.covers('/r/harborlight/index.ts')).toBe(false);
  });

  it('survive a restart, in a file only the owner can read', () => {
    new ComponentGrants(dir).grant('/r/saltmarsh/chart', 'Alice');
    expect(statSync(join(dir, 'component-grants.json')).mode & 0o777).toBe(0o600);
    const again = new ComponentGrants(dir);
    expect(again.covers('/r/saltmarsh/chart/a.ts')).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'component-grants.json'), 'utf8')).folders[0]).toEqual(
      expect.objectContaining({ folder: '/r/saltmarsh/chart', by: 'Alice' }),
    );
  });

  it('grant nothing from a file that cannot be read, and refuse to write over it', () => {
    writeFileSync(join(dir, 'component-grants.json'), '{not json');
    const grants = new ComponentGrants(dir);
    expect(grants.covers('/r/saltmarsh/chart/a.ts')).toBe(false);
    expect(() => grants.grant('/r/saltmarsh/chart', 'Alice')).toThrow(/cannot be read/);
    expect(readFileSync(join(dir, 'component-grants.json'), 'utf8')).toBe('{not json');
  });

  it('refuse a folder that is not an absolute path', () => {
    expect(() => new ComponentGrants(dir).grant('map', 'Alice')).toThrow(/absolute/);
  });
});
