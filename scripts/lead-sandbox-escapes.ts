/**
 * `--check`'s rows for the ways a lead could start a process outside the
 * wall (`escapeRules` in `lead-sandbox-lib.ts`). Each row drives the thing
 * from inside the profile and has a control outside it, so a row fails when
 * its rule is removed, not only when the probe itself breaks.
 *
 * Nothing here touches another session: the tmux row starts a server of its
 * own on a socket of its own and kills it, and the launchd row submits a job
 * that runs `/usr/bin/true` and removes it at once.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SANDBOX_EXEC } from './lead-sandbox-lib.ts';

export interface EscapeRow {
  ok: boolean;
  /** One line: what was tried and what answered. */
  says: string;
}

/**
 * The sandbox's own verdict on an operation, asked from inside it through
 * `sandbox_check`. `open` and `osascript` are proved this way because
 * driving them for real would start an app, or put a window on the screen.
 */
const SANDBOX_CHECK = `const { dlopen, ptr } = require('bun:ffi');
const lib = dlopen('/usr/lib/libSystem.B.dylib', {
  sandbox_check: { args: ['i32', 'ptr', 'i32'], returns: 'i32' },
});
console.log(lib.symbols.sandbox_check(process.pid, ptr(Buffer.from(process.env.OP + '\\0')), 0));`;

function verdict(profile: string, cwd: string, op: string): 'denied' | 'allowed' | 'error' {
  const r = spawnSync(SANDBOX_EXEC, ['-f', profile, 'bun', '-e', SANDBOX_CHECK], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, OP: op },
  });
  const out = r.status === 0 ? r.stdout.trim() : '';
  return out === '1' ? 'denied' : out === '0' ? 'allowed' : 'error';
}

function sandboxRow(profile: string, cwd: string, op: string, what: string): EscapeRow {
  const v = verdict(profile, cwd, op);
  return { ok: v === 'denied', says: `${what}: the sandbox says ${op} is ${v} (must be denied)` };
}

/**
 * A tmux server of this check's own, on a socket beside every fleet
 * session's. From inside, a lead in a tmux pane names the socket straight
 * from `$TMUX`, so the probe does too (`-S`): that connect is what the
 * `network-outbound` rule refuses. The second probe moves the socket into
 * the lead's project, where that rule would no longer match it; the file
 * deny on the folder refuses the move. Outside, the server must answer (the
 * control).
 */
let tmuxRuns = 0;

function tmuxRow(profile: string, cwd: string, uid: number): EscapeRow {
  // A new name per call: a server just killed can still hold the old one.
  const name = `lead-sandbox-check-${process.pid}-${++tmuxRuns}`;
  // The resolved spelling, where tmux itself puts it.
  const socket = `/private/tmp/tmux-${uid}/${name}`;
  const moved = join(cwd, `.${name}`);
  const outside = (...args: string[]) =>
    spawnSync('tmux', ['-S', socket, ...args], { stdio: 'ignore' }).status === 0;
  const inside = (script: string) =>
    spawnSync(SANDBOX_EXEC, ['-f', profile, '/bin/sh', '-c', script], {
      cwd,
      env: { ...process.env, TMUX: `${socket},0,0` },
      stdio: 'ignore',
    }).status === 0;
  // No tmux, no server for a lead to reach.
  if (spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0)
    return { ok: true, says: 'tmux: not installed, so there is no server to reach' };
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  if (!outside('new-session', '-d', '-s', 'check', 'sleep 60'))
    return { ok: false, says: 'tmux: could not start a server to test against' };
  // Its pid, to stop it by: a socket moved to a long path is past the
  // 104-byte limit on a socket address, so no client can reach it there.
  const pid = Number(
    spawnSync('tmux', ['-S', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' })
      .stdout,
  );
  try {
    const control = outside('ls');
    const connects = inside(`tmux -S '${socket}' ls`);
    const moves = inside(`mv '${socket}' '${moved}'`);
    return {
      ok: control && !connects && !moves,
      says: `tmux: its own server ${control ? 'answers' : 'does not answer'} outside (the control); from inside, connecting is ${connects ? 'allowed' : 'refused'} and moving its socket out is ${moves ? 'allowed' : 'refused'} (both must be refused)`,
    };
  } finally {
    outside('kill-server');
    if (pid > 0)
      try {
        process.kill(pid);
      } catch {
        // Already gone.
      }
    rmSync(moved, { force: true });
    // tmux leaves the socket file behind when its server is killed.
    rmSync(socket, { force: true });
  }
}

/** `shortcuts list` names the shortcuts outside (the control) and must fail inside. */
function shortcutsRow(profile: string, cwd: string): EscapeRow {
  const list = (argv: string[]) =>
    spawnSync(argv[0] ?? '', argv.slice(1), { cwd, stdio: 'ignore' }).status === 0;
  const outside = list(['/usr/bin/shortcuts', 'list']);
  const inside = list([SANDBOX_EXEC, '-f', profile, '/usr/bin/shortcuts', 'list']);
  return {
    ok: outside && !inside,
    says: `shortcuts: \`shortcuts list\` ${outside ? 'answers' : 'fails'} outside (the control), ${inside ? 'answers' : 'refused'} inside (must be refused)`,
  };
}

/**
 * launchd refuses a sandboxed caller's job; no rule of ours does this. The
 * control submits the same job from outside, where it must load. Each job
 * runs `/usr/bin/true` and is removed at once.
 */
function launchdRow(profile: string, cwd: string): EscapeRow {
  const label = `com.lead-sandbox.check-${process.pid}`;
  const submitted = (prefix: string[]) => {
    spawnSync(prefix[0] ?? '', [...prefix.slice(1), 'submit', '-l', label, '--', '/usr/bin/true'], {
      cwd,
      stdio: 'ignore',
    });
    const loaded = spawnSync('/bin/launchctl', ['list', label], { stdio: 'ignore' }).status === 0;
    if (loaded) spawnSync('/bin/launchctl', ['remove', label], { stdio: 'ignore' });
    return loaded;
  };
  const outside = submitted(['/bin/launchctl']);
  const inside = submitted([SANDBOX_EXEC, '-f', profile, '/bin/launchctl']);
  return {
    ok: outside && !inside,
    says: `launchd: a job submitted outside ${outside ? 'loads' : 'does not load'} (the control), from inside ${inside ? 'was loaded (removed again)' : 'was refused'} (must be refused)`,
  };
}

/**
 * A dummy item of the check's own, put in the keychain outside: read back
 * outside (the control), refused inside, and deleted either way. It never
 * reads a real item.
 */
export function keychainRow(profile: string, cwd: string): EscapeRow {
  // One fixed name, so a run killed before its delete is replaced (`-U`), not added to.
  const service = 'lead-sandbox-check-harborlight';
  const security = (prefix: string[], ...args: string[]) =>
    spawnSync(prefix[0] ?? '', [...prefix.slice(1), ...args], { cwd, stdio: 'ignore' }).status ===
    0;
  const outside = ['/usr/bin/security'];
  const inside = [SANDBOX_EXEC, '-f', profile, '/usr/bin/security'];
  if (
    !security(
      outside,
      'add-generic-password',
      '-U',
      '-a',
      'lead-sandbox',
      '-s',
      service,
      '-w',
      'dummy',
    )
  )
    return { ok: false, says: 'keychain: could not add a dummy item to test against' };
  try {
    const control = security(outside, 'find-generic-password', '-s', service, '-w');
    const read = security(inside, 'find-generic-password', '-s', service, '-w');
    return {
      ok: control && !read,
      says: `keychain: a dummy item ${control ? 'reads' : 'does not read'} outside (the control), ${read ? 'reads' : 'refused'} inside (must be refused)`,
    };
  } finally {
    security(outside, 'delete-generic-password', '-s', service);
  }
}

/** Every escape row for one lead's profile, run from the lead's first project. */
export function escapeRows(
  profile: string,
  cwd: string,
  uid: number,
  allowTmux = false,
): EscapeRow[] {
  return [
    allowTmux
      ? { ok: true, says: 'tmux: left reachable, as the config asks (allowTmux)' }
      : tmuxRow(profile, cwd, uid),
    sandboxRow(profile, cwd, 'lsopen', 'open'),
    sandboxRow(profile, cwd, 'appleevent-send', 'osascript'),
    shortcutsRow(profile, cwd),
    launchdRow(profile, cwd),
  ];
}
