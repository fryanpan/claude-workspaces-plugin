/**
 * The settings writer, against a settings file in a temp dir. No case here
 * names or opens a real settings file: every path is under `mkdtempSync`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SETTINGS_BACKUP_SUFFIX,
  defaultUserSettingsPath,
  editAllowList,
  readAllowList,
} from '../src/settings-allow-file.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempSettings(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'settings-allow-'));
  dirs.push(dir);
  const path = join(dir, 'settings.json');
  if (content !== undefined) writeFileSync(path, content, { mode: 0o644 });
  return path;
}

/** A file with every neighbour of `allow` a real one carries. */
const REALISTIC = `${JSON.stringify(
  {
    model: 'riverbend',
    permissions: {
      allow: ['Bash(git status:*)'],
      deny: ['Bash(rm -rf:*)'],
      ask: ['Bash(git push:*)'],
      defaultMode: 'default',
    },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
    env: { HARBORLIGHT_MODE: 'quiet' },
  },
  null,
  2,
)}\n`;

describe('appending allow lines', () => {
  it('adds exactly the listed lines and leaves every other key byte-identical', () => {
    const path = tempSettings(REALISTIC);
    const res = editAllowList(path, { add: ['Bash(git push --force-with-lease:*)'] });
    expect(res).toEqual({ ok: true, added: ['Bash(git push --force-with-lease:*)'], removed: [] });
    const after = JSON.parse(readFileSync(path, 'utf8'));
    const before = JSON.parse(REALISTIC);
    expect(after.permissions.allow).toEqual([
      'Bash(git status:*)',
      'Bash(git push --force-with-lease:*)',
    ]);
    expect(after.permissions.deny).toEqual(before.permissions.deny);
    expect(after.permissions.ask).toEqual(before.permissions.ask);
    // Every other key, and the key order, come back as they were.
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(Object.keys(after.permissions)).toEqual(Object.keys(before.permissions));
    expect({ ...after, permissions: undefined }).toEqual({ ...before, permissions: undefined });
    // Taking the line back out restores the original bytes exactly.
    expect(editAllowList(path, { remove: ['Bash(git push --force-with-lease:*)'] }).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(REALISTIC);
  });

  it('keeps a backup of the bytes it replaced, mode 600, and the file keeps its mode', () => {
    const path = tempSettings(REALISTIC);
    editAllowList(path, { add: ['Bash(git tag:*)'] });
    const backup = `${path}${SETTINGS_BACKUP_SUFFIX}`;
    expect(readFileSync(backup, 'utf8')).toBe(REALISTIC);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    // No temp file is left beside it.
    expect(readdirSync(join(path, '..')).filter((f) => f.endsWith('.cw-tmp'))).toEqual([]);
  });

  it('writes nothing for a line already present', () => {
    const path = tempSettings(REALISTIC);
    expect(editAllowList(path, { add: ['Bash(git status:*)'] })).toEqual({
      ok: true,
      added: [],
      removed: [],
    });
    expect(existsSync(`${path}${SETTINGS_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('creates a missing file holding only the new lines, mode 600', () => {
    const path = tempSettings();
    expect(editAllowList(path, { add: ['Bash(git tag:*)'] }).ok).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      permissions: { allow: ['Bash(git tag:*)'] },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps the indent the file already used', () => {
    const path = tempSettings('{\n    "permissions": {\n        "allow": []\n    }\n}\n');
    editAllowList(path, { add: ['Bash(git tag:*)'] });
    expect(readFileSync(path, 'utf8')).toBe(
      '{\n    "permissions": {\n        "allow": [\n            "Bash(git tag:*)"\n        ]\n    }\n}\n',
    );
  });

  it('edits a symlinked file at its target and leaves the link a link', () => {
    const target = tempSettings(REALISTIC);
    const link = join(join(target, '..'), 'linked-settings.json');
    symlinkSync(target, link);
    expect(editAllowList(link, { add: ['Bash(git tag:*)'] }).ok).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readAllowList(target)).toEqual({
      ok: true,
      allow: ['Bash(git status:*)', 'Bash(git tag:*)'],
    });
  });
});

describe('refusing to write', () => {
  it('writes nothing to a file that does not parse', () => {
    const broken = '{ "permissions": { "allow": [] }, // a comment\n}\n';
    const path = tempSettings(broken);
    const res = editAllowList(path, { add: ['Bash(git tag:*)'] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('unparseable');
    expect(readFileSync(path, 'utf8')).toBe(broken);
    expect(existsSync(`${path}${SETTINGS_BACKUP_SUFFIX}`)).toBe(false);
  });

  it('writes nothing when permissions.allow is not a list', () => {
    const odd = '{"permissions":{"allow":"Bash(git tag:*)"}}';
    const path = tempSettings(odd);
    const res = editAllowList(path, { add: ['Bash(git push:*)'] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('allow-not-a-list');
    expect(readFileSync(path, 'utf8')).toBe(odd);
  });

  it('writes nothing when the file changes underfoot, and keeps the other save', () => {
    const path = tempSettings(REALISTIC);
    const theirs = REALISTIC.replace('quiet', 'loud');
    const res = editAllowList(
      path,
      { add: ['Bash(git tag:*)'] },
      { beforeSwap: () => writeFileSync(path, theirs) },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('changed-underfoot');
    expect(readFileSync(path, 'utf8')).toBe(theirs);
    expect(readdirSync(join(path, '..')).filter((f) => f.endsWith('.cw-tmp'))).toEqual([]);
  });
});

describe('removing allow lines', () => {
  it('removes only the named line, and a line already gone is fine', () => {
    const path = tempSettings(
      '{"permissions":{"allow":["Bash(git status:*)","Bash(git tag:*)"],"deny":["Bash(git tag:*)"]}}\n',
    );
    const res = editAllowList(path, { remove: ['Bash(git tag:*)', 'Bash(git push:*)'] });
    expect(res).toEqual({ ok: true, added: [], removed: ['Bash(git tag:*)'] });
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.permissions.allow).toEqual(['Bash(git status:*)']);
    // The deny list names the same string and is untouched.
    expect(after.permissions.deny).toEqual(['Bash(git tag:*)']);
  });
});

describe('where the real file would be', () => {
  it('honours CLAUDE_CONFIG_DIR, and otherwise names settings.json under .claude', () => {
    expect(defaultUserSettingsPath({ CLAUDE_CONFIG_DIR: '/tmp/riverbend-config' })).toBe(
      '/tmp/riverbend-config/settings.json',
    );
    expect(defaultUserSettingsPath({}).endsWith(join('.claude', 'settings.json'))).toBe(true);
  });
});

describe('a folder somebody else can write', () => {
  // A walled lead can write `~/.claude` outside the settings files
  // themselves, and the server's pid is in the discovery file. If the temp
  // name could be guessed, a link planted there would carry the write to a
  // file the lead edits and then rename the link itself onto settings.json.
  it('a link at any guessable temp name is never written through or renamed into place', () => {
    const path = tempSettings(REALISTIC);
    const dir = join(path, '..');
    const victim = join(dir, 'lead-owned.json');
    const start = Date.now();
    for (let ms = start - 50; ms < start + 3_000; ms++)
      symlinkSync(victim, join(dir, `.settings-${process.pid}-${ms}.cw-tmp`));
    const res = editAllowList(path, { add: ['Bash(git tag:*)'] });
    expect(res.ok).toBe(true);
    expect(existsSync(victim)).toBe(false);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readAllowList(path)).toEqual({
      ok: true,
      allow: ['Bash(git status:*)', 'Bash(git tag:*)'],
    });
  });

  it('a temp file swapped for a link before the rename is refused', () => {
    const path = tempSettings(REALISTIC);
    const dir = join(path, '..');
    const victim = join(dir, 'lead-owned.json');
    writeFileSync(victim, '{}');
    const res = editAllowList(
      path,
      { add: ['Bash(git tag:*)'] },
      {
        beforeSwap: () => {
          for (const name of readdirSync(dir)) {
            if (!name.endsWith('.tmp') && !name.endsWith('.cw-tmp')) continue;
            rmSync(join(dir, name));
            symlinkSync(victim, join(dir, name));
          }
        },
      },
    );
    expect(res.ok).toBe(false);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(REALISTIC);
  });
});
