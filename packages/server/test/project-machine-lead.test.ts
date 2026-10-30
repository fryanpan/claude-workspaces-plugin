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
import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

describe.skipIf(BASH === null)('the lead on the machine', () => {
  it('runs as lead, with its sign-in and none of the machine’s other secrets', async () => {
    // The real mkdir and ln: the lead makes its own folders on the volume.
    const { root, bin, log, volume } = stubs(scratch, '0', ['mkdir', 'ln']);
    const homes = join(root, 'home');
    mkdirSync(join(homes, 'lead'), { recursive: true });
    start([entrypoint], {
      ...machineEnv(bin, volume),
      CW_MACHINE_HOME_ROOT: homes,
      CLAUDE_CODE_OAUTH_TOKEN: LEAD_TOKEN,
      FLY_APP_NAME: 'cw-riverbend',
    });
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
    expect(lead?.env.get('CW_BASE_URL')).toBe('http://127.0.0.1:8787');
    expect(lead?.env.get('CW_AGENT_NAME')).toBe('riverbend-lead');
    expect(lead?.env.get('HOME')).toBe(join(homes, 'lead'));
    expect(lead?.env.get('DISABLE_AUTOUPDATER')).toBe('1');

    // Nothing else of root's: not the server's key, not the tunnel's or the
    // bucket's. An allowlist, so a new machine secret is kept out too.
    const others = [...Object.values(SECRETS), ...Object.values(SERVER_OWN)];
    expect(
      [...(lead?.env.values() ?? [])].filter((v) => others.some((s) => v.includes(s))),
    ).toEqual([]);
    const bashOwn = new Set(['PWD', 'SHLVL', '_', 'OLDPWD']);
    expect([...(lead?.env.keys() ?? [])].filter((k) => !bashOwn.has(k)).sort()).toEqual(
      [
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CW_AGENT_NAME',
        'CW_BASE_URL',
        'CW_LEAD_ROOT',
        'DISABLE_AUTOUPDATER',
        'HOME',
        'LOGNAME',
        'PATH',
        'STUB_UID',
        'TERM',
        'USER',
      ].sort(),
    );

    // ...and the sign-in is the lead's alone: no process of the server's
    // user holds it.
    const cw = recs.filter((r) => r.uid === 'cw');
    expect(cw.length).toBeGreaterThan(0);
    expect(cw.filter((r) => [...r.env.values()].some((v) => v.includes(LEAD_TOKEN)))).toEqual([]);
    // No secret is an argument, which any user can read.
    expect(
      [...recs.map((r) => r.argv), ...setprivArgv].filter((a) => a.includes(LEAD_TOKEN)),
    ).toEqual([]);

    // The server's folders are closed to the lead, and the lead's to the server.
    expect(lines(log, '.chown')).toContain(`root -h lead:lead ${volume}/lead`);
    expect(lines(log, '.chmod')).toContain(
      `root 0700 ${volume}/cw ${volume}/claude-projects ${volume}/lead`,
    );
    // Nobody is at the terminal to answer the first-run questions.
    const seeded = JSON.parse(readFileSync(join(homes, 'lead', '.claude.json'), 'utf8'));
    expect(seeded.hasCompletedOnboarding).toBe(true);
    expect(seeded.projects[`${volume}/lead/work`].hasTrustDialogAccepted).toBe(true);
  }, 30_000);

  it('starts no lead when the machine has no sign-in for one', async () => {
    const { bin, log, volume } = stubs(scratch, '0');
    const { out } = start([entrypoint], machineEnv(bin, volume));
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
  }, 30_000);
});

/** lead.sh supervise on its own, as the lead user would run it, on the pretend clock. */
function supervisor() {
  const s = stubs(scratch, '0', ['mkdir', 'ln'], {
    sleep: `echo "$1" >> "$CLOCK.sleeps"; echo $(( $(cat "$CLOCK") + $1 )) > "$CLOCK"; exec /bin/sleep 0.01`,
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
