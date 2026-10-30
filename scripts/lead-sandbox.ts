#!/usr/bin/env bun
/**
 * Start a Mac lead's `claude` under a Seatbelt profile that walls it off
 * from other projects' files. Needs no sudo and no admin password, so an
 * agent applies it. Runbook: `docs/process/lead-sandbox.md`. What the
 * profile holds: `lead-sandbox-lib.ts`.
 *
 *   bun scripts/lead-sandbox.ts --config <file>                 # dry run: profiles + launch commands
 *   bun scripts/lead-sandbox.ts --config <file> --write         # write the profiles
 *   bun scripts/lead-sandbox.ts --config <file> --check         # prove each wall from inside it
 *   bun scripts/lead-sandbox.ts --config <file> --check --turn  # and one `claude -p` turn per lead
 *   bun scripts/lead-sandbox.ts --config <file> --lead <name> -- claude [args]   # launch
 *   bun scripts/lead-sandbox.ts --config <file> --lead <name> --claude-account <label> -- claude
 *
 * Profiles go to `~/.config/claude-workspaces/lead-sandbox/`, or to
 * `--profiles <dir>`. A config path or profile folder given relative is
 * taken from the current folder.
 *
 * `--check` lists each lead's own projects (they must list: the control)
 * and each protected folder (it must refuse) from inside that lead's
 * profile, asks `bun` there for its environment (it must not be empty),
 * tries each way out of the wall (`lead-sandbox-escapes.ts`: tmux, `open`,
 * `osascript`, `shortcuts`, launchd), reads a dummy keychain item it made
 * (it must be refused), plants a file beside the `claude` binary (it must
 * be refused), connects to each board server's port at each of this
 * machine's addresses for a lead with `boardWall` (it must be refused with
 * EPERM; the control is the same profile without the wall), connects to its
 * own board's socket (it must not be refused) and to each other board's
 * socket in the folder (it must be, and must connect without the wall), and
 * exits 1 on any failure. The socket rows need a server with board sockets
 * on; with no other board's socket to try, that row fails rather than pass
 * on nothing. With `--turn` it also has `claude -p` answer once inside each
 * profile; without it that row is named as not run.
 *
 * A launch reads the lead's Claude Code token from the keychain, outside the
 * wall, and hands it over as `CLAUDE_CODE_OAUTH_TOKEN`
 * (`lead-sandbox-token.ts`): the token of the Claude account
 * `--claude-account` names, else the one the config gives the lead.
 *
 * A lead with `boardWall` is launched with `CW_BOARD_SOCKET` naming its own
 * board's socket (`boardSocketEnv`), so its MCP child is the node relay
 * dialling that socket (packages/plugin/bin/claude-workspaces-mcp.sh) and it
 * holds no board token: the server keeps the one its calls carry. The
 * plugin's hooks post over the same socket. Before the lead starts, the
 * launch tells the server which folders it can write, its projects
 * (`lead-sandbox-roots.ts`), and starts nothing if the server does not
 * take them. Prod serves board sockets by default.
 */
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ensureGitProxyFiles, gitProxyEnv, gitProxyLeadDir } from './git-proxy-lead.ts';
import {
  boardSocketRows,
  boardWallRows,
  escapeRows,
  installRow,
  keychainRow,
} from './lead-sandbox-escapes.ts';
import { gitHooksPath, hooksPathRefusal } from './lead-sandbox-git.ts';
import {
  CLAUDE_LAUNCHER,
  type Lead,
  type LeadSandboxConfig,
  type Machine,
  SANDBOX_EXEC,
  buildProfile,
  checkTargets,
  launchCommand,
  parseConfig,
} from './lead-sandbox-lib.ts';
import { type RootsRegistrar, leadRoots, registerRootsWithCurl } from './lead-sandbox-roots.ts';
import {
  type TokenReader,
  readKeychainToken,
  resolveAccount,
  tokenEnv,
  tokenService,
  turnCheck,
} from './lead-sandbox-token.ts';
import { defaultBoardSocketDir, wallHosts } from './lead-sandbox-wall.ts';
import { shellQuote } from './mac-lead-users-lib.ts';

const machine: Machine = {
  home: homedir(),
  uid: process.getuid?.() ?? 0,
  realpath(path) {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
};

const PROFILE_DIR = join(homedir(), '.config', 'claude-workspaces', 'lead-sandbox');
let profileDir = PROFILE_DIR;

function profilePath(lead: Lead): string {
  return join(profileDir, `${lead.name}.sb`);
}

/**
 * For a lead that names GitHub repos: its proxy token (made once) and git
 * config, and the environment that points its git at them. Nothing for the rest.
 */
function gitProxyFiles(lead: Lead, config: LeadSandboxConfig): Record<string, string> {
  if (lead.githubRepos.length === 0) return {};
  const dir = gitProxyLeadDir(machine.home, lead.name);
  const url = `http://127.0.0.1:${config.gitProxyPort}`;
  return gitProxyEnv(ensureGitProxyFiles(lead.name, dir, url).gitconfig);
}

function writeProfile(lead: Lead, config: LeadSandboxConfig, guard: string[]): string {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  // Made outside the wall, which denies the lead every write to it but its
  // own folders: one the lead made would be the lead's.
  mkdirSync(join(machine.home, '.claude', 'projects'), { recursive: true, mode: 0o700 });
  const path = profilePath(lead);
  writeFileSync(path, buildProfile(lead, config, machine, guard), { mode: 0o600 });
  return path;
}

/** Whether `/bin/ls` lists `path` from inside the profile. */
function lists(profile: string, path: string): boolean {
  const r = spawnSync(SANDBOX_EXEC, ['-f', profile, '/bin/ls', path], { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * How many variables `bun` (from PATH, as the hooks run it) sees inside the
 * profile, from the lead's first project. Zero is the failure: the hooks
 * then lose the workspace they post to.
 */
function bunEnvCount(profile: string, cwd: string): number {
  const r = spawnSync(
    SANDBOX_EXEC,
    ['-f', profile, 'bun', '-e', 'console.log(Object.keys(process.env).length)'],
    { cwd, encoding: 'utf8' },
  );
  return r.status === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

/** The board wall's rows, against the same profile written without the wall as the control. */
function wallRows(
  lead: Lead,
  config: LeadSandboxConfig,
  guard: string[],
  profile: string,
  cwd: string,
): Array<{ ok: boolean; says: string }> {
  if (!lead.boardWall) return [{ ok: true, says: 'board wall: off, as the config leaves it' }];
  const unwalled = join(profileDir, `${lead.name}.unwalled.sb`);
  writeFileSync(unwalled, buildProfile({ ...lead, boardWall: false }, config, machine, guard), {
    mode: 0o600,
  });
  const dir = config.boardSocketDir ?? defaultBoardSocketDir(machine.uid);
  const own = join(dir, `${lead.boardId}.sock`);
  const others = otherSockets(dir, own);
  try {
    return [
      ...boardWallRows(profile, unwalled, cwd, wallHosts(networkInterfaces())),
      ...boardSocketRows(profile, unwalled, cwd, own, others),
      ...(others.length === 0
        ? [{ ok: false, says: `board socket: no other board's socket in ${dir} to try` }]
        : []),
    ];
  } finally {
    rmSync(unwalled, { force: true });
  }
}

/** Every socket in `dir` but `own`: the boards a walled lead must not reach. */
function otherSockets(dir: string, own: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => join(dir, n))
    .filter((p) => p !== own && p.endsWith('.sock') && lstatSync(p).isSocket());
}

/**
 * A walled lead's way to its board: its own board's socket, and that board
 * as its default. Nothing for a lead without the wall.
 */
export function boardSocketEnv(
  lead: { boardWall: boolean; boardId?: string },
  config: { boardSocketDir?: string },
  uid: number,
): Record<string, string> {
  if (!lead.boardWall || !lead.boardId) return {};
  const dir = config.boardSocketDir ?? defaultBoardSocketDir(uid);
  return { CW_BOARD_SOCKET: join(dir, `${lead.boardId}.sock`), CW_WORKSPACE_ID: lead.boardId };
}

/**
 * The launcher's own environment, less any value that is a board server
 * bearer (`at1.`, `at2.`): whatever shell ran this, the lead inherits none.
 */
export function withoutBoardBearers(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => !/(^|[^A-Za-z0-9])at[12]\./.test(value ?? '')),
  );
}

/** What `main` reaches outside itself, so a test can stand in for each. */
export interface LaunchDeps {
  platform: string;
  say: (line: string) => void;
  /** The stored Claude Code token, read outside the wall. */
  readToken: TokenReader;
  /** Starts the lead with the terminal handed through; answers its exit status. */
  spawn: (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => number;
  /** Tells the server the folders a walled lead can write. */
  registerRoots: RootsRegistrar;
  /** `core.hooksPath` in a project (`lead-sandbox-git.ts`); git by default. */
  hooksPathOf?: (project: string) => string | null;
}

const realDeps: LaunchDeps = {
  platform: process.platform,
  say: (line) => process.stdout.write(`${line}\n`),
  readToken: readKeychainToken,
  registerRoots: registerRootsWithCurl,
  spawn(file, args, opts) {
    // Ctrl-C interrupts the lead's turn; it must not kill this wrapper and
    // leave the session running without its parent.
    for (const sig of ['SIGINT', 'SIGQUIT'] as const) process.on(sig, () => {});
    return spawnSync(file, args, { ...opts, stdio: 'inherit' }).status ?? 1;
  },
};

export function main(argv: string[], deps: LaunchDeps = realDeps): number {
  const { say } = deps;
  if (deps.platform !== 'darwin') {
    say('Seatbelt is macOS only.');
    return 2;
  }
  const dashes = argv.indexOf('--');
  const own = dashes >= 0 ? argv.slice(0, dashes) : argv;
  const command = dashes >= 0 ? argv.slice(dashes + 1) : [];
  const flag = (name: string) => {
    const at = own.indexOf(name);
    return at >= 0 ? own[at + 1] : undefined;
  };
  const given = flag('--config');
  if (!given) {
    say(
      'usage: bun scripts/lead-sandbox.ts --config <file> [--write | --check | --lead <name> -- <command>]',
    );
    return 2;
  }
  const file = resolve(given);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    say(
      `config refused: ${file} is not readable JSON (${err instanceof Error ? err.message : err})`,
    );
    return 2;
  }
  const parsed = parseConfig(raw, machine.home);
  if (!parsed.ok) {
    say(`config refused: ${parsed.error}`);
    return 2;
  }
  const { config } = parsed;
  profileDir = resolve(flag('--profiles') ?? PROFILE_DIR);
  const accountFlag = flag('--claude-account');
  const guard = [file, profileDir];

  const leadName = flag('--lead');
  if (leadName !== undefined) {
    const lead = config.leads.find((l) => l.name === leadName);
    if (!lead) {
      say(`no lead named ${leadName} in ${file}`);
      return 2;
    }
    if (command.length === 0) {
      say('nothing to launch: put the command after --');
      return 2;
    }
    const hooks = hooksPathRefusal(
      lead.projects,
      deps.hooksPathOf ?? ((p) => gitHooksPath(p)),
      machine.realpath,
    );
    if (hooks) {
      say(`launch refused for ${lead.name}: ${hooks}`);
      return 2;
    }
    if (lead.boardWall && lead.boardId) {
      const refused = deps.registerRoots(lead.boardId, leadRoots(lead, machine.realpath));
      // The list is what holds the server's reads and git to the lead's
      // projects, so a lead the server does not know about is not started.
      if (refused) {
        say(
          `launch refused for ${lead.name}: the server did not take its projects and allowed folders (${refused}), so it would follow links and run git in them unguarded. Start the server and launch again.`,
        );
        return 2;
      }
    }
    const here = machine.realpath(import.meta.dirname);
    if (lead.projects.some((p) => here.startsWith(`${machine.realpath(p)}/`)))
      say(
        `warning: this script runs from ${here}, inside ${lead.name}'s own project, so the lead can edit the generator of its next profile. Launch from prod's checkout.`,
      );
    const account = resolveAccount(lead, config, accountFlag);
    if (!account.ok) {
      say(`launch refused for ${lead.name}: ${account.error}`);
      return 2;
    }
    const token = tokenEnv(lead, account.account, deps.readToken);
    if (!token.ok) {
      say(`launch refused for ${lead.name}: ${token.error}`);
      return 2;
    }
    const launch = launchCommand(lead, writeProfile(lead, config, guard), command);
    const env = {
      ...withoutBoardBearers(process.env),
      ...gitProxyFiles(lead, config),
      ...boardSocketEnv(lead, config, machine.uid),
      ...token.env,
    };
    return deps.spawn(launch.argv[0] ?? SANDBOX_EXEC, launch.argv.slice(1), {
      cwd: launch.cwd,
      env,
    });
  }

  if (own.includes('--check')) {
    const turn = own.includes('--turn');
    let bad = 0;
    let total = 0;
    let notRun = 0;
    for (const lead of config.leads) {
      const profile = writeProfile(lead, config, guard);
      const t = checkTargets(lead, config, machine);
      for (const [path, must] of [
        ...t.own.map((p) => [p, true] as const),
        ...t.protected.map((p) => [p, false] as const),
      ]) {
        const listed = lists(profile, path);
        const ok = listed === must;
        total++;
        if (!ok) bad++;
        const what = must ? 'own project (must list)' : 'protected (must not list)';
        say(
          `${ok ? 'ok  ' : 'FAIL'} ${lead.name}  ${listed ? 'lists' : 'refused'}  ${path}  ${what}`,
        );
      }
      const cwd = launchCommand(lead, profile, []).cwd;
      const vars = bunEnvCount(profile, cwd);
      total++;
      if (vars === 0) bad++;
      say(
        `${vars > 0 ? 'ok  ' : 'FAIL'} ${lead.name}  bun sees ${vars} env vars  in ${cwd}  (must be more than 0)`,
      );
      const keychain = lead.allowKeychain
        ? { ok: true, says: 'keychain: left readable, as the config asks (allowKeychain)' }
        : keychainRow(profile, cwd);
      const install = installRow(
        profile,
        cwd,
        dirname(machine.realpath(join(machine.home, CLAUDE_LAUNCHER))),
      );
      for (const row of [
        ...escapeRows(profile, cwd, machine.uid, lead.allowTmux),
        keychain,
        install,
        ...wallRows(lead, config, guard, profile, cwd),
      ]) {
        total++;
        if (!row.ok) bad++;
        say(`${row.ok ? 'ok  ' : 'FAIL'} ${lead.name}  ${row.says}`);
      }
      const account = resolveAccount(lead, config, accountFlag);
      if (!account.ok) {
        say(`check refused: ${account.error}`);
        return 2;
      }
      const row = turnCheck(lead, profile, cwd, {
        turn,
        account: account.account,
        read: deps.readToken,
        env: { ...process.env, ...gitProxyFiles(lead, config) },
      });
      if (!row.ran) {
        notRun++;
        say(`skip ${lead.name}  ${row.says}`);
      } else {
        total++;
        if (!row.ok) bad++;
        say(`${row.ok ? 'ok  ' : 'FAIL'} ${lead.name}  ${row.says}`);
      }
    }
    const skipped = notRun > 0 ? ` ${notRun} not run (claude turn; add --turn).` : '';
    say(
      `${bad === 0 ? `All ${total} checks hold.` : `${bad} of ${total} checks failed.`}${skipped}`,
    );
    return bad === 0 ? 0 : 1;
  }

  const write = own.includes('--write');
  for (const lead of config.leads) {
    const path = profilePath(lead);
    if (write) {
      writeProfile(lead, config, guard);
      gitProxyFiles(lead, config);
    } else {
      say(`# ${path}`);
      say(buildProfile(lead, config, machine, guard));
    }
    const wrapper = ['bun', join(import.meta.dirname, 'lead-sandbox.ts'), '--config', file];
    if (profileDir !== PROFILE_DIR) wrapper.push('--profiles', profileDir);
    say(`${lead.name}: ${shellQuote([...wrapper, '--lead', lead.name, '--', 'claude'])}`);
    const launch = launchCommand(lead, path, ['claude']);
    say(`  which runs, in ${launch.cwd}: ${shellQuote(launch.argv)}`);
    const account = resolveAccount(lead, config, accountFlag);
    if (!account.ok) {
      say(`  ${account.error}`);
      return 2;
    }
    say(
      `  signed in to Claude as ${account.account ? `account ${account.account}` : 'the one unlabelled account'}, with the token in keychain item ${tokenService(account.account)}`,
    );
    if (lead.githubRepos.length > 0)
      say(
        `  with git sent to the GitHub proxy on 127.0.0.1:${config.gitProxyPort} for ${lead.githubRepos.join(', ')}; token and git config in ${gitProxyLeadDir(machine.home, lead.name)}`,
      );
  }
  say(
    write
      ? `Wrote ${config.leads.length} profile(s) to ${profileDir}.`
      : 'Dry run. Nothing was written.',
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
