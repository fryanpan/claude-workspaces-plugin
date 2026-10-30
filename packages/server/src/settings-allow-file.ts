/**
 * The one module on this server that writes a Claude Code settings file, and
 * the only key it ever changes is `permissions.allow`.
 *
 * It exists for the grant card (`permission-grants.ts`): the board's owner
 * approves a list of allow rules in the browser, and this appends exactly
 * those lines; when the task closes, it removes exactly the lines the ledger
 * says the server added. Every other key — `permissions.deny`,
 * `permissions.ask`, hooks, env, anything Claude Code adds later — is read
 * and written back untouched, in its original key order.
 *
 * THE FOUR GUARDS, in the order they run:
 *  1. **Unparseable means untouched.** A file that is not strict JSON (a
 *     comment, a trailing comma, a truncated write) or whose `permissions` or
 *     `permissions.allow` is the wrong type is refused before anything is
 *     written. Nothing is "repaired".
 *  2. **Backup first.** The bytes as read are copied to `<file>.cw-backup`
 *     (mode 600) before the new version is written.
 *  3. **One-step replace.** The new text goes to a temp file beside the
 *     original with the original's mode, and `rename(2)` swaps it in. A
 *     reader sees the old file or the new one, never half of either.
 *  4. **Changed underfoot means untouched.** Just before the swap the file is
 *     read again; if it no longer holds the bytes this edit started from
 *     (Claude Code or a person saved it meanwhile), the temp file is dropped
 *     and the edit is refused, so their change is never overwritten.
 *
 * A symlinked settings file (a dotfiles checkout) is edited at its target,
 * so the link survives.
 *
 * WHAT A ROUND-TRIP CHANGES. The file is parsed and re-serialized, so
 * whitespace is normalized to the indent the file already used (two spaces
 * when it cannot tell), `\uXXXX` escapes come back as the characters they
 * stand for, a number written `1.0` comes back `1`, and a duplicated key
 * keeps only its last value. Key order and every value survive. A file that
 * ended in a newline still does.
 *
 * The path is never derived here. `defaultUserSettingsPath` names the real
 * file and only `bin.ts` calls it; every other caller, tests included, passes
 * a path it chose.
 */
import { chmodSync, copyFileSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type PendingTemp,
  commitTemp,
  discardTemp,
  writeTempBeside,
} from '@claude-workspaces/core/safe-file';

/** Where the owner's user settings live: `$CLAUDE_CONFIG_DIR/settings.json`,
 *  else `~/.claude/settings.json`. Called from `bin.ts` alone. */
export function defaultUserSettingsPath(env: Record<string, string | undefined>): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  return join(dir, 'settings.json');
}

export const SETTINGS_BACKUP_SUFFIX = '.cw-backup';

export type SettingsRefusal =
  | 'unreadable'
  | 'unparseable'
  | 'not-an-object'
  | 'permissions-not-an-object'
  | 'allow-not-a-list'
  | 'changed-underfoot'
  | 'write-failed';

export type AllowRead =
  | { ok: true; allow: string[] }
  | { ok: false; error: SettingsRefusal; message: string };

export type AllowEdit =
  | { ok: true; added: string[]; removed: string[] }
  | { ok: false; error: SettingsRefusal; message: string };

type Parsed =
  | { ok: true; bytes: string | null; root: Record<string, unknown>; allow: unknown[] }
  | { ok: false; error: SettingsRefusal; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The file's real location: a symlink is followed so the link survives. */
function target(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function readBytes(path: string): { ok: true; bytes: string | null } | { ok: false } {
  if (!existsSync(path)) return { ok: true, bytes: null };
  try {
    return { ok: true, bytes: readFileSync(path, 'utf8') };
  } catch {
    return { ok: false };
  }
}

function parse(path: string): Parsed {
  const read = readBytes(path);
  if (!read.ok) {
    return { ok: false, error: 'unreadable', message: 'the settings file could not be read' };
  }
  if (read.bytes === null) return { ok: true, bytes: null, root: {}, allow: [] };
  let root: unknown;
  try {
    root = JSON.parse(read.bytes);
  } catch {
    return {
      ok: false,
      error: 'unparseable',
      message: 'the settings file is not valid JSON, so nothing was written',
    };
  }
  if (!isPlainObject(root)) {
    return { ok: false, error: 'not-an-object', message: 'the settings file is not a JSON object' };
  }
  const perms = root.permissions;
  if (perms !== undefined && !isPlainObject(perms)) {
    return {
      ok: false,
      error: 'permissions-not-an-object',
      message: '`permissions` in the settings file is not an object, so nothing was written',
    };
  }
  const allow = perms?.allow;
  if (allow !== undefined && !Array.isArray(allow)) {
    return {
      ok: false,
      error: 'allow-not-a-list',
      message: '`permissions.allow` in the settings file is not a list, so nothing was written',
    };
  }
  return { ok: true, bytes: read.bytes, root, allow: allow ?? [] };
}

/** The indent the file already uses, so a re-serialize keeps its look. */
function indentOf(bytes: string | null): string {
  const m = bytes ? /\n([ \t]+)\S/.exec(bytes) : null;
  return m?.[1] ?? '  ';
}

/** The allow list as it stands, for a caller deciding what it would add. */
export function readAllowList(path: string): AllowRead {
  const parsed = parse(target(path));
  if (!parsed.ok) return parsed;
  return { ok: true, allow: parsed.allow.filter((r): r is string => typeof r === 'string') };
}

/**
 * Append `add` (each line not already present) and remove `remove` (the last
 * occurrence of each, since appended lines sit at the end) from
 * `permissions.allow`, changing nothing else. A line to remove that is not
 * there is fine and is simply not in `removed`. No change, no write.
 */
export function editAllowList(
  path: string,
  edit: { add?: readonly string[]; remove?: readonly string[] },
  /** Runs between writing the temp file and the underfoot check — the one
   *  moment a concurrent save can land. A test seam; nothing else passes it. */
  hooks: { beforeSwap?: () => void } = {},
): AllowEdit {
  const file = target(path);
  const parsed = parse(file);
  if (!parsed.ok) return parsed;
  const allow = [...parsed.allow];
  const removed: string[] = [];
  for (const rule of edit.remove ?? []) {
    const at = allow.lastIndexOf(rule);
    if (at === -1) continue;
    allow.splice(at, 1);
    removed.push(rule);
  }
  const added: string[] = [];
  for (const rule of edit.add ?? []) {
    if (allow.includes(rule)) continue;
    allow.push(rule);
    added.push(rule);
  }
  if (added.length === 0 && removed.length === 0) return { ok: true, added, removed };
  // A missing file with nothing to add stays missing: removal above found
  // nothing, so this line is reached only with lines to write.

  // Rebuild `permissions` in place, so its key order and every sibling of
  // `allow` (deny, ask, defaultMode, …) come back exactly as they were read.
  const perms = isPlainObject(parsed.root.permissions) ? parsed.root.permissions : undefined;
  const nextPerms: Record<string, unknown> = perms ? { ...perms, allow } : { allow };
  const nextRoot: Record<string, unknown> = { ...parsed.root, permissions: nextPerms };
  const trailing = parsed.bytes === null || parsed.bytes.endsWith('\n') ? '\n' : '';
  const text = `${JSON.stringify(nextRoot, null, indentOf(parsed.bytes))}${trailing}`;

  const mode = parsed.bytes === null ? 0o600 : statSync(file).mode & 0o777;
  // A random temp name, created new and never through a link: a walled lead
  // can write this folder, and a guessable name (it was pid + time) let a
  // link planted there carry the write elsewhere and then be renamed onto
  // the settings file itself. `commitTemp` checks the name still holds the
  // file written before renaming it.
  let pending: PendingTemp | null = null;
  try {
    if (parsed.bytes !== null) {
      const backup = `${file}${SETTINGS_BACKUP_SUFFIX}`;
      copyFileSync(file, backup);
      chmodSync(backup, 0o600);
    }
    pending = writeTempBeside(file, text, mode);
    hooks.beforeSwap?.();
    const now = readBytes(file);
    if (!now.ok || now.bytes !== parsed.bytes) {
      discardTemp(pending);
      return {
        ok: false,
        error: 'changed-underfoot',
        message: 'the settings file changed while this edit was being made, so nothing was written',
      };
    }
    commitTemp(pending, file);
  } catch {
    if (pending) discardTemp(pending);
    return { ok: false, error: 'write-failed', message: 'the settings file could not be written' };
  }
  return { ok: true, added, removed };
}
