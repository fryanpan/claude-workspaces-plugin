/**
 * The owner's program folders outside home (`lead-sandbox-owner-bins.ts`):
 * which folders the walk finds, and that the profile makes them read only
 * under the real sandbox-exec, beside a write to the lead's own project.
 */
import { spawnSync } from 'node:child_process';
import {
  constants,
  accessSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { installRow } from './lead-sandbox-escapes.ts';
import { type Machine, SANDBOX_EXEC, buildProfile, parseConfig } from './lead-sandbox-lib.ts';
import { ownerBinFolders, withOwnerBins, xcrunCachePaths } from './lead-sandbox-owner-bins.ts';

/** A machine of folders, each writable or not; every other path is missing. */
function walk(
  folders: Record<string, boolean>,
  pathDirs: string[],
  keep: string[] = ['/Users/harborlight'],
  links: Record<string, string> = {},
) {
  return ownerBinFolders({
    pathDirs,
    keep,
    realpath: (p) => links[p] ?? p,
    exists: (p) => p in folders,
    writable: (p) => folders[p] === true,
  });
}

describe('ownerBinFolders', () => {
  it('finds the highest writable folder above each PATH folder, and /Applications', () => {
    const folders = {
      '/opt': false,
      '/opt/homebrew': true,
      '/opt/homebrew/bin': true,
      '/usr': false,
      '/usr/local': false,
      '/usr/local/bin': true,
      '/usr/bin': false,
      '/Applications': true,
    };
    expect(walk(folders, ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])).toEqual([
      '/Applications',
      '/opt/homebrew',
      '/usr/local/bin',
    ]);
  });

  it('finds nothing where the owner can write nothing (the control)', () => {
    expect(walk({ '/usr': false, '/usr/bin': false }, ['/usr/bin', 'relative/bin'])).toEqual([]);
  });

  it('leaves out the home folder, its twin, temp folders, and folders above a lead project', () => {
    const folders = {
      '/Users/harborlight/.bun/bin': true,
      '/Volumes/Data': true,
      '/Volumes/Data/Users': true,
      '/Volumes/Data/Users/harborlight': true,
      '/Volumes/Data/Users/harborlight/.bun': true,
      '/Volumes/Data/Users/harborlight/.bun/bin': true,
      '/srv': true,
      '/srv/tools': true,
      '/srv/tools/bin': true,
      '/private/tmp': true,
      '/private/tmp/bin': true,
    };
    const keep = ['/Users/harborlight', '/Volumes/Data/Users/harborlight', '/srv/tools/riverbend'];
    const links = { '/Users/harborlight/.bun/bin': '/Volumes/Data/Users/harborlight/.bun/bin' };
    expect(
      walk(
        folders,
        ['/Users/harborlight/.bun/bin', '/srv/tools/bin', '/private/tmp/bin'],
        keep,
        links,
      ),
    ).toEqual(['/srv/tools/bin']);
  });
});

const RUN = process.platform === 'darwin' && existsSync(SANDBOX_EXEC);

describe.skipIf(!RUN)('owner program folders under the real sandbox-exec', () => {
  // Vitest runs a skipped suite's body too, and Linux has no /private/tmp.
  const root = RUN ? realpathSync(mkdtempSync('/private/tmp/owner-bins-')) : '/nonexistent';
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(home, 'dev', 'harborlight');
  const brewRoot = join(root, 'homebrew');
  const brew = join(brewRoot, 'bin', 'brew');

  const profileFor = (ownerBins: string[], machineHome = home, xcrunCache: string[] = []) => {
    const parsed = parseConfig(
      { leads: [{ name: 'harborlight', projects: [project] }] },
      machineHome,
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const lead = parsed.config.leads[0];
    if (!lead) throw new Error('fixture has one lead');
    const m: Machine = { home: machineHome, uid: 501, realpath: (p) => p, ownerBins, xcrunCache };
    const file = join(root, `profile-${ownerBins.length}-${xcrunCache.length}.sb`);
    writeFileSync(file, buildProfile(lead, parsed.config, m));
    return file;
  };
  const append = (profile: string, file: string) =>
    spawnSync(SANDBOX_EXEC, ['-f', profile, '/bin/sh', '-c', `echo planted >> '${file}'`], {
      cwd: project,
    }).status;

  it("refuses a write to an owner program, and still writes the lead's own project", () => {
    mkdirSync(project, { recursive: true });
    mkdirSync(join(brewRoot, 'bin'), { recursive: true });
    writeFileSync(brew, '#!/bin/sh\necho brew\n', { mode: 0o755 });
    const walled = profileFor([brewRoot]);
    expect(append(walled, brew)).not.toBe(0);
    expect(readFileSync(brew, 'utf8')).toBe('#!/bin/sh\necho brew\n');
    expect(append(walled, join(brewRoot, 'new-tool'))).not.toBe(0);
    // The positive control: the same profile writes the lead's own project.
    expect(append(walled, join(project, 'notes.md'))).toBe(0);
    expect(readFileSync(join(project, 'notes.md'), 'utf8')).toBe('planted\n');
    // The mutation control: without the rule, the same write lands.
    expect(append(profileFor([]), brew)).toBe(0);
  });

  it("refuses a write to Xcode's shim cache, and to renaming its folder away", () => {
    // A stand-in for DARWIN_USER_TEMP_DIR; the real cache is never touched.
    const temp = join(root, 'var-folders', 'T');
    mkdirSync(temp, { recursive: true });
    mkdirSync(project, { recursive: true });
    const db = join(temp, 'xcrun_db');
    writeFileSync(db, 'real\n');
    const walled = profileFor([], home, xcrunCachePaths(`${temp}/`));
    expect(append(walled, db)).not.toBe(0);
    expect(readFileSync(db, 'utf8')).toBe('real\n');
    const move = (profile: string) =>
      spawnSync(SANDBOX_EXEC, ['-f', profile, '/bin/mv', temp, `${temp}-moved`]).status;
    expect(move(walled)).not.toBe(0);
    // Positive controls: other files in that folder, and the lead's project.
    expect(append(walled, join(temp, 'scratch'))).toBe(0);
    expect(append(walled, join(project, 'notes.md'))).toBe(0);
    // The mutation control: without the rule, the same write lands.
    expect(append(profileFor([]), db)).toBe(0);
  });

  const realBrew = '/opt/homebrew';
  const ownerCanWrite = (() => {
    try {
      accessSync(realBrew, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!ownerCanWrite)(
    'finds /opt/homebrew on this Mac and refuses a file there',
    () => {
      const real = realpathSync(process.env.HOME ?? '/');
      const parsed = parseConfig({ leads: [{ name: 'harborlight', projects: [project] }] }, real);
      if (!parsed.ok) throw new Error(parsed.error);
      const m = withOwnerBins({ home: real, uid: 501, realpath: (p: string) => p }, parsed.config);
      expect(m.ownerBins).toContain(realBrew);
      const profile = profileFor([...m.ownerBins], real);
      const row = installRow(profile, project, realBrew, 'owner programs');
      expect(row, row.says).toMatchObject({ ok: true });
    },
    30_000,
  );
});
