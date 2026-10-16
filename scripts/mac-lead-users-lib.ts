/**
 * A macOS user for each Mac lead and helper, walled off from the folders it
 * must not read. The runbook is `docs/process/mac-lead-users.md`; the CLI is
 * `mac-lead-users.ts`.
 *
 * Today every Mac session runs as the owner's macOS user, so a lead steered
 * by an outsider's text can read every board's data, every repo and every
 * credential on disk. This gives each lead a standard (non-admin) user of its
 * own, and adds a deny entry for that user to the ACL of every protected
 * folder: the owner's home and its data volume twin, which hold the board
 * data folder, the repos and the credentials, and every other lead's home. A
 * deny on a folder's `list` and `search` stops the user reading or entering
 * it, whatever the modes below it say.
 *
 * Everything here goes through `System`, so the tests drive a fake one and
 * nothing in this module can touch the machine. Three rules hold by
 * construction:
 *
 *   - it adds and never removes: `apply` runs only the three changes
 *     `isAllowedChange` names, so it cannot delete a user, a file or an ACL
 *     entry;
 *   - it is idempotent: `plan` reads the machine first and names only what is
 *     missing, so a second run plans nothing;
 *   - it prints every change before it makes it, and stops at the first one
 *     that fails.
 */

export interface LeadUser {
  /** The short macOS account name: `cw-` and lowercase words. */
  name: string;
  /** What the login window and `id -F` show. */
  fullName: string;
}

export interface LeadUsersConfig {
  users: LeadUser[];
  /** Folders no lead user may read. Each is protected at its real path too. */
  protect: string[];
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** The machine, as this module may ask about it and change it. */
export interface System {
  /** Run a command. `interactive` hands it the terminal (a password prompt). */
  run(argv: readonly string[], opts?: { interactive?: boolean }): RunResult;
  isRoot(): boolean;
  /** The path with every symlink resolved, or the path itself if it is missing. */
  realpath(path: string): string;
  isDirectory(path: string): boolean;
}

export const DSCL = '/usr/bin/dscl';
export const SYSADMINCTL = '/usr/sbin/sysadminctl';
export const CREATEHOMEDIR = '/usr/sbin/createhomedir';
export const DSEDITGROUP = '/usr/sbin/dseditgroup';
export const CHMOD = '/bin/chmod';
export const LS = '/bin/ls';
export const SUDO = '/usr/bin/sudo';

/**
 * What a lead user is denied on a protected folder: reading its listing,
 * entering it, changing its entries, and reading its attributes or ACL. Not
 * inherited: a folder the user cannot enter needs nothing below it.
 */
export const DENY_RIGHTS =
  'list,search,add_file,add_subdirectory,delete_child,readattr,readextattr,readsecurity';

const NAME = /^cw-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 31;

/** One step, said in words and as the exact command it runs. */
export interface Change {
  says: string;
  argv: string[];
  interactive?: boolean;
}

export type Problem = { user: string; says: string };

export interface Plan {
  changes: Change[];
  /** Users the script refuses to touch, and why. Nothing is changed for them. */
  problems: Problem[];
  /** Every folder protected, at its real path. */
  protectedPaths: string[];
}

/** The config, checked, or the reason it is refused. */
export function parseConfig(
  raw: unknown,
  defaultProtect: readonly string[],
): { ok: true; config: LeadUsersConfig } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false, error: 'config is not an object' };
  const r = raw as { users?: unknown; protect?: unknown };
  if (!Array.isArray(r.users) || r.users.length === 0)
    return { ok: false, error: 'config.users must list at least one user' };
  const users: LeadUser[] = [];
  const seen = new Set<string>();
  for (const u of r.users as unknown[]) {
    const name = (u as { name?: unknown })?.name;
    const fullName = (u as { fullName?: unknown })?.fullName;
    if (typeof name !== 'string' || !NAME.test(name) || name.length > MAX_NAME)
      return {
        ok: false,
        error: `user name ${JSON.stringify(name)} must be cw- and lowercase words, at most ${MAX_NAME} characters`,
      };
    if (typeof fullName !== 'string' || fullName.trim() === '' || /["\n\r]/.test(fullName))
      return { ok: false, error: `${name}: fullName must be non-empty, one line, with no quotes` };
    if (seen.has(name)) return { ok: false, error: `${name} is listed twice` };
    seen.add(name);
    users.push({ name, fullName: fullName.trim() });
  }
  let protect: string[];
  if (r.protect === undefined) protect = [...defaultProtect];
  else if (Array.isArray(r.protect) && r.protect.every((p) => typeof p === 'string'))
    protect = r.protect as string[];
  else return { ok: false, error: 'config.protect must be a list of folder paths' };
  for (const p of protect) {
    if (!p.startsWith('/')) return { ok: false, error: `protect path ${p} must be absolute` };
    if (p === '/' || /\/\.\.?(\/|$)/.test(p))
      return {
        ok: false,
        error: `protect path ${p} must name one folder, not / or a relative step`,
      };
  }
  if (protect.length === 0) return { ok: false, error: 'config.protect is empty' };
  return { ok: true, config: { users, protect } };
}

/**
 * Each path and, where a symlink leads elsewhere, its real path too. A
 * protection on one end of a symlink alone does not hold: an ACL sits on the
 * real folder, and Seatbelt matches the resolved path.
 */
export function expandRealPaths(
  paths: readonly string[],
  realpath: (path: string) => string,
): string[] {
  return [...new Set(paths.flatMap((p) => [p, realpath(p)]))];
}

/** The user's home folder as directory services records it, or null. */
function homeOf(sys: System, name: string): string | null {
  const r = sys.run([DSCL, '.', '-read', `/Users/${name}`, 'NFSHomeDirectory']);
  if (r.status !== 0) return null;
  const m = r.stdout.match(/NFSHomeDirectory:\s*(\S.*)$/m);
  return m?.[1]?.trim() ?? null;
}

function isAdmin(sys: System, name: string): boolean {
  const r = sys.run([DSEDITGROUP, '-o', 'checkmember', '-m', name, 'admin']);
  return r.status === 0 && /^yes\b/.test(r.stdout.trim());
}

/** Whether the folder's ACL already denies this user listing and entering it. */
export function hasDeny(aclListing: string, name: string): boolean {
  return aclListing.split('\n').some((line) => {
    const m = line.match(/^\s*\d+:\s+user:(\S+)\s+(?:inherited\s+)?deny\s+(\S+)/);
    if (!m || m[1] !== name) return false;
    const rights = new Set((m[2] ?? '').split(','));
    return rights.has('list') && rights.has('search');
  });
}

/** Where a user's home will be: what directory services says, or the default. */
function intendedHome(sys: System, name: string): string {
  return homeOf(sys, name) ?? `/Users/${name}`;
}

/**
 * Read the machine and say what is missing. Reads only: `dscl -read`,
 * `dseditgroup -o checkmember` and `ls -led`.
 */
export function plan(sys: System, config: LeadUsersConfig): Plan {
  const changes: Change[] = [];
  const problems: Problem[] = [];
  const blocked = new Set<string>();
  const homes = new Map<string, string>();

  for (const u of config.users) {
    const exists = homeOf(sys, u.name) !== null;
    if (exists && isAdmin(sys, u.name)) {
      problems.push({
        user: u.name,
        says: `${u.name} exists and is an admin. This script never demotes a user: remove it from admin by hand, then run again.`,
      });
      blocked.add(u.name);
      continue;
    }
    const home = intendedHome(sys, u.name);
    homes.set(u.name, home);
    if (!exists) {
      changes.push({
        says: `create standard user ${u.name} ("${u.fullName}"), home ${home}; you will be asked for its password`,
        argv: [
          SYSADMINCTL,
          '-addUser',
          u.name,
          '-fullName',
          u.fullName,
          '-home',
          home,
          '-password',
          '-',
        ],
        interactive: true,
      });
    }
    if (!exists || !sys.isDirectory(home)) {
      changes.push({
        says: `create the home folder ${home} for ${u.name}`,
        argv: [CREATEHOMEDIR, '-c', '-u', u.name],
      });
    }
  }

  const protectedPaths = expandRealPaths(config.protect, (p) => sys.realpath(p));
  for (const u of config.users) {
    if (blocked.has(u.name)) continue;
    const others = config.users
      .filter((o) => o.name !== u.name)
      .map((o) => homes.get(o.name))
      .filter((h): h is string => h !== undefined);
    for (const path of [...new Set([...protectedPaths, ...others])]) {
      const willExist = others.includes(path) || sys.isDirectory(path);
      if (!willExist) continue;
      const acl = sys.isDirectory(path)
        ? sys.run([LS, '-led', path])
        : { status: 1, stdout: '', stderr: '' };
      if (acl.status === 0 && hasDeny(acl.stdout, u.name)) continue;
      changes.push({
        says: `deny ${u.name} reading or entering ${path}`,
        argv: [CHMOD, '+a', `user:${u.name} deny ${DENY_RIGHTS}`, path],
      });
    }
  }
  return { changes, problems, protectedPaths };
}

/**
 * The only three changes this module may make: add a standard user, create
 * its home, and add one deny entry to a folder's ACL. Anything else, a
 * removal included, is refused before it runs.
 */
export function isAllowedChange(change: Change): boolean {
  const [bin, ...args] = change.argv;
  if (bin === SYSADMINCTL) return args[0] === '-addUser' && !args.includes('-admin');
  if (bin === CREATEHOMEDIR) return args.length === 3 && args[0] === '-c' && args[1] === '-u';
  if (bin === CHMOD) {
    return (
      args.length === 3 &&
      args[0] === '+a' &&
      /^user:cw-[a-z0-9-]+ deny [a-z_,]+$/.test(args[1] ?? '')
    );
  }
  return false;
}

/**
 * Make the changes in order, printing each before it runs. Stops at the
 * first failure and says which; nothing after it runs.
 */
export function apply(
  sys: System,
  changes: readonly Change[],
  say: (line: string) => void,
): { ok: boolean; made: number } {
  if (!sys.isRoot()) {
    say('refused: --apply creates users and changes ACLs, so run it with sudo.');
    return { ok: false, made: 0 };
  }
  let made = 0;
  for (const c of changes) {
    if (!isAllowedChange(c)) {
      say(`refused: "${c.says}" is not one of the three changes this script makes.`);
      return { ok: false, made };
    }
    say(`→ ${c.says}`);
    say(`  $ ${shellQuote(c.argv)}`);
    const r = sys.run(c.argv, c.interactive ? { interactive: true } : undefined);
    if (r.status !== 0) {
      say(`  failed (exit ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
      return { ok: false, made };
    }
    made++;
  }
  return { ok: true, made };
}

export interface CheckRow {
  user: string;
  path: string;
  /** `own` is the positive control: the user must reach its own home. */
  kind: 'own' | 'protected';
  readable: boolean;
  ok: boolean;
}

/**
 * Prove the wall from the other side: list each folder as each lead user.
 * Its own home must list (the control: a refusal everywhere would also read
 * as walled off), and every protected folder must not.
 */
export function check(sys: System, config: LeadUsersConfig): CheckRow[] {
  const rows: CheckRow[] = [];
  const p = plan(sys, config);
  for (const u of config.users) {
    const home = homeOf(sys, u.name);
    if (home === null) {
      rows.push({ user: u.name, path: '(no such user)', kind: 'own', readable: false, ok: false });
      continue;
    }
    const others = config.users
      .filter((o) => o.name !== u.name)
      .map((o) => homeOf(sys, o.name))
      .filter((h): h is string => h !== null);
    const as = (path: string) => sys.run([SUDO, '-n', '-u', u.name, LS, path]).status === 0;
    const own = as(home);
    rows.push({ user: u.name, path: home, kind: 'own', readable: own, ok: own });
    for (const path of [...new Set([...p.protectedPaths, ...others])]) {
      if (!sys.isDirectory(path)) continue;
      const readable = as(path);
      rows.push({ user: u.name, path, kind: 'protected', readable, ok: !readable });
    }
  }
  return rows;
}

/** A command as a person would type it, for the printed line only. */
export function shellQuote(argv: readonly string[]): string {
  return argv
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}
