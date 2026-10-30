/**
 * The project's lead agent on its machine (`infra/project-machine/lead.sh`,
 * started by `entrypoint.sh`).
 *
 * Two things are held here. First, the lead runs as a user of its own with
 * its Claude Code sign-in and nothing else: a user's processes can read each
 * other's environment (`/proc/<pid>/environ`), so a lead that shared the
 * server's user, or inherited the entrypoint's environment, would hold the
 * tunnel token, the bucket credential and the server's Claude key. Second,
 * the supervisor starts the session again when it ends, within a minute, and
 * backs off when it cannot start.
 *
 * Nothing real runs: `claude`, `tmux`, `setpriv` and the rest are stubs from
 * `project-machine-harness.ts`. In the supervisor's tests `sleep` and `date`
 * share a pretend clock, which each sleep moves on by its length, so a
 * ten-minute backoff takes milliseconds. That the kernel refuses another
 * user's `/proc/<pid>/environ` is Linux's, checked in a container when this
 * was written, not here.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, execSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASH,
  type Rec,
  SECRETS,
  SERVER_OWN,
  lines,
  machineDir,
  machineEnv,
  readRecords,
  stubs,
} from './project-machine-harness.ts';
import { waitFor } from './wait-for.ts';

const entrypoint = join(machineDir, 'entrypoint.sh');
const leadScript = join(machineDir, 'lead.sh');
const LEAD_TOKEN = 'sk-ant-oat-fixture-riverbend-lead';
const BOARD = 'w-riverbend';
const DEPLOY_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-deploy-key-harborlight\n-----END OPENSSH PRIVATE KEY-----\n';

if (BASH === null) console.warn('[project-machine-lead] SKIPPED: no bash 4.3+ on PATH');

const scratch = mkdtempSync(join(tmpdir(), 'machine-lead-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) if (c.pid && c.exitCode === null) process.kill(-c.pid, 'SIGKILL');
});

/** Started in a process group of its own, so everything it starts can be stopped. */
function start(
  args: string[],
  env: Record<string, string>,
): { child: ChildProcess; out: string[] } {
  const child = spawn(BASH as string, args, {
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const out: string[] = [];
  child.stdout?.on('data', (d: Buffer) => out.push(d.toString()));
  child.stderr?.on('data', (d: Buffer) => out.push(d.toString()));
  return { child, out };
}

const find = (recs: Rec[], prog: string) => recs.filter((r) => r.argv.split(' ')[0] === prog);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A cgroup v2 root with the memory controller, as the kernel would show it. */
function cgroupRoot(root: string): string {
  const cg = join(root, 'cgroup');
  mkdirSync(join(cg, 'cw-lead'), { recursive: true });
  writeFileSync(join(cg, 'cgroup.controllers'), 'cpuset cpu io memory pids\n');
  writeFileSync(join(cg, 'cgroup.subtree_control'), '');
  writeFileSync(join(cg, 'cw-lead', 'memory.oom.group'), '0\n');
  return cg;
}

/** The entrypoint, on a machine that has a lead: a sign-in and a board. */
function leadMachine(extra: Record<string, string> = {}, prepare?: (volume: string) => void) {
  const s = stubs(scratch, '0', ['mkdir', 'ln']);
  prepare?.(s.volume);
  const homes = join(s.root, 'home');
  mkdirSync(join(homes, 'lead'), { recursive: true });
  const run = start([entrypoint], {
    ...machineEnv(s.bin, s.volume),
    CW_MACHINE_HOME_ROOT: homes,
    CLAUDE_CODE_OAUTH_TOKEN: LEAD_TOKEN,
    CW_LEAD_BOARD: BOARD,
    CW_LEAD_GITHUB_DEPLOY_KEY: Buffer.from(DEPLOY_KEY).toString('base64'),
    FLY_APP_NAME: 'cw-riverbend',
    ...extra,
  });
  return { ...s, ...run, homes };
}

describe.skipIf(BASH === null)('the lead on the machine', () => {
  it('runs as lead, with its sign-in, its board’s socket and its deploy key, and nothing else', async () => {
    const cg = cgroupRoot(mkdtempSync(join(scratch, 'cg-')));
    // A copy set aside by a restore, and a link dressed as one.
    const m = leadMachine({ CW_MACHINE_CGROUP_ROOT: cg }, (volume) => {
      mkdirSync(join(volume, 'cw.before-restore-1'));
      symlinkSync(scratch, join(volume, 'link.before-restore-2'));
    });
    const { log, volume, homes } = m;
    await waitFor(
      () =>
        find(readRecords(log).recs, 'claude').length > 0 &&
        find(readRecords(log).recs, 'bun').length > 0,
      { timeout: 20_000, describe: 'the lead and the server to start' },
    );
    const { recs, setprivArgv } = readRecords(log);
    const [lead] = find(recs, 'claude');

    expect(lead?.uid).toBe('lead');
    expect(setprivArgv.filter((a) => a.includes('--reuid=lead'))).toHaveLength(1);
    expect(lead?.argv).toBe('claude --plugin-dir /app/packages/plugin');
    // POSITIVE CONTROL: the recorder sees the one secret the lead holds.
    expect(lead?.env.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe(LEAD_TOKEN);
    // Its board, through that board's socket, and no TCP address to call.
    expect(lead?.env.get('CW_BOARD_SOCKET')).toBe(`${volume}/boards/${BOARD}.sock`);
    expect(lead?.env.get('CW_WORKSPACE_ID')).toBe(BOARD);
    expect(lead?.env.get('CW_AGENT_NAME')).toBe('riverbend-lead');
    expect(lead?.env.get('HOME')).toBe(join(homes, 'lead'));
    expect(lead?.env.get('SHELL')).toBe('/bin/bash');
    expect(lead?.env.get('DISABLE_AUTOUPDATER')).toBe('1');

    // Nothing else of root's: not the server's key, not the tunnel's or the
    // bucket's. An allowlist, so a new machine secret is kept out too. The
    // deploy key is in its file, not in the session's environment.
    const others = [...Object.values(SECRETS), ...Object.values(SERVER_OWN)];
    expect(
      [...(lead?.env.values() ?? [])].filter((v) => others.some((s) => v.includes(s))),
    ).toEqual([]);
    const bashOwn = new Set(['PWD', 'SHLVL', '_', 'OLDPWD']);
    expect([...(lead?.env.keys() ?? [])].filter((k) => !bashOwn.has(k)).sort()).toEqual(
      [
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CW_AGENT_NAME',
        'CW_BOARD_SOCKET',
        'CW_LEAD_ROOT',
        'CW_WORKSPACE_ID',
        'DISABLE_AUTOUPDATER',
        'HOME',
        'LOGNAME',
        'PATH',
        'SHELL',
        'STUB_UID',
        'TERM',
        'USER',
      ].sort(),
    );

    // The deploy key: the lead's file, 0600, and git told to use only it.
    const keyFile = join(homes, 'lead', '.ssh', 'github_deploy_key');
    expect(readFileSync(keyFile, 'utf8')).toBe(DEPLOY_KEY);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(lines(log, '.git')).toEqual([
      `lead config --global core.sshCommand ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes`,
    ]);

    // The sign-in and the deploy key are the lead's alone: no process of any
    // other user (the server, the tunnel) holds either.
    const encodedKey = Buffer.from(DEPLOY_KEY).toString('base64');
    const notLead = recs.filter((r) => r.uid !== 'lead');
    expect(notLead.filter((r) => r.uid === 'cw').length).toBeGreaterThan(0);
    expect(notLead.filter((r) => r.uid === 'cwtunnel').length).toBeGreaterThan(0);
    expect(
      notLead.filter((r) =>
        [...r.env.values()].some((v) => v.includes(LEAD_TOKEN) || v.includes(encodedKey)),
      ),
    ).toEqual([]);
    // No secret is an argument, which any user can read.
    expect(
      [...recs.map((r) => r.argv), ...setprivArgv].filter(
        (a) => a.includes(LEAD_TOKEN) || a.includes(encodedKey),
      ),
    ).toEqual([]);

    // The server opens the board sockets, shares the lead's board's, and
    // refuses the lead's uid over TCP.
    const [server] = find(recs, 'bun').filter((r) => r.argv.includes('bin.ts'));
    expect(server?.env.get('CW_BOARD_SOCKET_DIR')).toBe(`${volume}/boards`);
    expect(server?.env.get('CW_BOARD_SOCKET_SHARED')).toBe(BOARD);
    expect(server?.env.get('CW_LOOPBACK_REFUSED_UIDS')).toBe('10004');

    // The server's folders are closed to the lead, and the lead's to the
    // server; the socket folder lets the lead's group through, not list.
    expect(lines(log, '.chown')).toContain(`root -h lead:lead ${volume}/lead`);
    expect(lines(log, '.chown')).toContain(`root -h cw:lead ${volume}/boards`);
    const chmods = lines(log, '.chmod');
    expect(chmods).toContain(`root 0700 ${volume}/cw ${volume}/claude-projects ${volume}/lead`);
    expect(chmods).toContain(`root 0710 ${volume}/boards`);
    expect(chmods).toContain(`root 0700 ${volume}/cw.before-restore-1`);
    expect(chmods.filter((c) => c.includes('link.before-restore'))).toEqual([]);

    // The lead's memory has a ceiling of its own, and the lead is in it.
    expect(readFileSync(join(cg, 'cgroup.subtree_control'), 'utf8').trim()).toBe('+memory');
    expect(readFileSync(join(cg, 'cw-lead', 'memory.max'), 'utf8').trim()).toBe('1280M');
    expect(readFileSync(join(cg, 'cw-lead', 'memory.oom.group'), 'utf8').trim()).toBe('1');
    expect(Number(readFileSync(join(cg, 'cw-lead', 'cgroup.procs'), 'utf8'))).toBeGreaterThan(0);
    expect(m.out.join('')).toContain("the lead's memory is capped at 1280M");

    // Nobody is at the terminal to answer the first-run questions.
    const seeded = JSON.parse(readFileSync(join(homes, 'lead', '.claude.json'), 'utf8'));
    expect(seeded.hasCompletedOnboarding).toBe(true);
    expect(seeded.projects[`${volume}/lead/work`].hasTrustDialogAccepted).toBe(true);
  }, 30_000);

  it('starts no lead when the machine has no sign-in for one, or no board', async () => {
    for (const env of [{}, { CLAUDE_CODE_OAUTH_TOKEN: LEAD_TOKEN }] as Record<string, string>[]) {
      const { bin, log, volume } = stubs(scratch, '0');
      const { out } = start([entrypoint], { ...machineEnv(bin, volume), ...env });
      await waitFor(() => out.join('').includes('no lead agent runs'), {
        timeout: 20_000,
        describe: 'the entrypoint to pass the lead by',
      });
      await waitFor(() => find(readRecords(log).recs, 'cloudflared').length > 0, {
        timeout: 20_000,
        describe: 'the tunnel to start',
      });
      const { recs, setprivArgv } = readRecords(log);
      expect(find(recs, 'claude')).toEqual([]);
      expect(setprivArgv.filter((a) => a.includes('--reuid=lead'))).toEqual([]);
    }
  }, 45_000);

  it('starts the lead’s supervisor again when the lead kills it, and leaves the server running', async () => {
    // No cgroup at this root: the lead runs uncapped, and says so.
    const m = leadMachine({ CW_MACHINE_CGROUP_ROOT: join(scratch, 'no-cgroup') });
    await waitFor(() => lines(m.log, '.claude-pids').length === 1, {
      timeout: 20_000,
      describe: 'the first session',
    });
    expect(m.out.join('')).toContain("the lead's memory is NOT capped");
    const supervisors = () =>
      execSync('ps -Ao pid=,pgid=,command=', { encoding: 'utf8' })
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .filter(
          ([, pgid, ...cmd]) =>
            Number(pgid) === m.child.pid && cmd.join(' ').includes('lead.sh supervise'),
        )
        .map(([pid]) => Number(pid));
    const [first] = supervisors();
    expect(first).toBeGreaterThan(0);
    // What the lead could do: it owns its supervisor.
    process.kill(first as number, 'SIGKILL');
    await waitFor(() => m.out.join('').includes('session already running; watching it'), {
      timeout: 20_000,
      describe: 'a new supervisor to take the session over',
    });
    expect(m.out.join('')).toContain("the lead's supervisor exited");
    const { recs, setprivArgv } = readRecords(m.log);
    expect(setprivArgv.filter((a) => a.includes('--reuid=lead'))).toHaveLength(2);
    // The same session, not a second one, and the server and tunnel once each.
    expect(lines(m.log, '.claude-pids')).toHaveLength(1);
    expect(find(recs, 'bun').filter((r) => r.argv.includes('bin.ts'))).toHaveLength(1);
    expect(find(recs, 'cloudflared')).toHaveLength(1);
    expect(m.child.exitCode).toBeNull();
  }, 45_000);
});

/** lead.sh supervise on its own, as the lead user would run it, on the pretend clock. */
function supervisor() {
  const s = stubs(scratch, '0', ['mkdir', 'ln'], {
    // Moved into place, so a reader never sees the clock half written.
    sleep: `echo "$1" >> "$CLOCK.sleeps"; echo $(( $(cat "$CLOCK") + $1 )) > "$CLOCK.$$"; /bin/mv "$CLOCK.$$" "$CLOCK"; exec /bin/sleep 0.01`,
    date: `if [ "$1" = +%s ]; then cat "$CLOCK"; else exec /bin/date "$@"; fi`,
  });
  const clock = join(s.log, '.clock');
  writeFileSync(clock, '1000000\n');
  const home = join(s.root, 'home', 'lead');
  mkdirSync(home, { recursive: true });
  const run = start([leadScript, 'supervise'], {
    PATH: `${s.bin}:/usr/bin:/bin`,
    HOME: home,
    CLOCK: clock,
    CW_LEAD_ROOT: join(s.volume, 'lead'),
    CW_AGENT_NAME: 'riverbend-lead',
    CLAUDE_CODE_OAUTH_TOKEN: LEAD_TOKEN,
  });
  const pids = () => lines(s.log, '.claude-pids').map(Number);
  const delays = () =>
    [...run.out.join('').matchAll(/starting it again in (\d+)s/g)].map((m) => Number(m[1]));
  const now = () => Number(readFileSync(clock, 'utf8'));
  return { ...s, ...run, home, pids, delays, now };
}

describe.skipIf(BASH === null)('the lead supervisor', () => {
  it('starts a killed session again within a minute, and stops it on TERM', async () => {
    const sup = supervisor();
    await waitFor(() => sup.pids().length === 1, {
      timeout: 10_000,
      describe: 'the first session',
    });
    const [first] = sup.pids() as [number];
    process.kill(first, 'SIGKILL');
    await waitFor(() => sup.pids().length === 2, { timeout: 10_000, describe: 'a second session' });
    // The 5s check, then the first wait: inside a minute.
    expect(sup.delays()).toEqual([5]);
    expect(existsSync(join(sup.home, '.claude', 'projects'))).toBe(true);

    const [, second] = sup.pids() as [number, number];
    expect(alive(second)).toBe(true);
    process.kill(sup.child.pid as number, 'SIGTERM');
    await waitFor(() => !alive(second), {
      timeout: 10_000,
      describe: 'the session to stop with it',
    });
  }, 30_000);

  it('backs off a session that cannot start, and resets once one lasts', async () => {
    const sup = supervisor();
    const exits = join(sup.log, '.claude-exits');
    writeFileSync(exits, '');
    await waitFor(() => sup.delays().length >= 8, {
      timeout: 15_000,
      describe: 'eight quick ends',
    });
    // Doubling to a 50s cap, then every ten minutes once six in a row failed.
    expect(sup.delays().slice(0, 8)).toEqual([5, 10, 20, 40, 50, 600, 600, 600]);

    unlinkSync(exits);
    const before = sup.pids().length;
    await waitFor(() => sup.pids().length > before, {
      timeout: 15_000,
      describe: 'a session that stays',
    });
    const ended = sup.delays().length;
    const since = sup.now();
    await waitFor(() => sup.now() - since >= 400, {
      timeout: 15_000,
      describe: 'the session to last five minutes',
    });
    // Still the same session: no end was logged while the clock ran on.
    expect(sup.delays().length).toBe(ended);
    process.kill(sup.pids().at(-1) as number, 'SIGKILL');
    await waitFor(() => sup.delays().length > ended, { timeout: 10_000, describe: 'the end' });
    expect(sup.delays().at(-1)).toBe(5);
  }, 45_000);
});
