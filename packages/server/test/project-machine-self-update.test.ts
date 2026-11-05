/**
 * A project machine upgrading itself end to end: the real `entrypoint.sh`
 * and the real release modules, against a throwaway key pair and a local
 * release store. Nobody runs a deploy command. CI publishes a release, the
 * machine's own release check downloads it and exits, and the restart that
 * follows (Fly's restart policy, played here by the test starting the
 * entrypoint again) boots it.
 *
 * As in `project-machine-entrypoint.test.ts` there is no container: `id`,
 * `setpriv`, `cloudflared` and `curl` are stubs. `bun` is a stub that runs
 * `release-cli.ts` with the real Bun and stands in for the server, writing
 * down the app directory it was started from. `curl` answering 200 is a
 * server that stays up; answering 000 is one that never binds.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../../../infra/project-machine/release-store.ts';
import { BASH, SECRETS, lines, machineDir, machineEnv, stubs } from './project-machine-harness.ts';
import { Store } from './project-machine-release-channel.ts';
import { commitFor, makeKeys, publish, writeImage } from './project-machine-release-fixture.ts';
import { waitFor } from './wait-for.ts';

const entrypoint = join(machineDir, 'entrypoint.sh');
const scratch = mkdtempSync(join(tmpdir(), 'machine-self-update-'));
const store = new Store(scratch);
const running: ChildProcess[] = [];
afterAll(() => {
  for (const c of running) killGroup(c);
  store.stop();
  rmSync(scratch, { recursive: true, force: true });
});
const keys = makeKeys();

/** Stops a boot and everything it started; its group may already be gone. */
function killGroup(c: ChildProcess): void {
  try {
    if (c.pid) process.kill(-c.pid, 'SIGKILL');
  } catch {
    // ESRCH: nothing of that boot is left.
  }
}

/**
 * bun: the release CLI for real, recording the user and environment it ran
 * with; anything else naming bin.ts is the server, which records its argv
 * and stays up, or exits at once when it runs a release and FAIL_RELEASE is
 * in the stub.
 */
function bunStub(failRelease: boolean): string {
  return `log="$(dirname "$0")/../log"
case "$*" in
  *release-cli.ts*)
    { echo "uid=\${STUB_UID:-root}"; /usr/bin/env; } > "$log/.release-env.$$"
    exec "${process.execPath}" "$@" ;;
  *bin.ts*)
    echo "$*" >> "$log/.server"
    ${failRelease ? 'case "$*" in */releases/*) exit 1 ;; esac' : ''}
    exec /bin/sleep 1000 ;;
esac
exit 0`;
}

function machine(opts: { answers: boolean; failRelease?: boolean }) {
  const image = writeImage(mkdtempSync(join(scratch, 'image-')), keys, 1);
  const { bin, log, volume } = stubs(scratch, '0', [], {
    bun: bunStub(opts.failRelease ?? false),
    curl: opts.answers ? 'printf 200' : 'printf 000',
  });
  const env = {
    ...machineEnv(bin, volume),
    CW_MACHINE_APP_ROOT: image,
    CW_RELEASE_CHANNEL_URL: store.url,
    // The sleep stub turns a 10s sleep into 0.2s: the poll and the probes run at once.
    CW_RELEASE_POLL_SECONDS: '10',
  };
  const releases = join(volume, 'releases');
  /** One boot of the machine. Resolves with its exit code, if it exits. */
  const boot = () => {
    const child = spawn(BASH as string, [entrypoint], { env, detached: true, stdio: 'ignore' });
    running.push(child);
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    return { child, exited, kill: () => killGroup(child) };
  };
  const servers = () => lines(log, '.server');
  const serverRanFrom = async (n: number) => {
    await waitFor(() => servers().length >= n, { timeout: 20_000, describe: `server start ${n}` });
    const argv = servers()[n - 1] ?? '';
    return argv.split(' ').find((a) => a.endsWith('/packages/server/src/bin.ts')) ?? '';
  };
  return { image, log, releases, boot, serverRanFrom };
}

const binOf = (app: string) => join(app, 'packages', 'server', 'src', 'bin.ts');

describe.skipIf(BASH === null)('a project machine updating itself', () => {
  it('downloads a newly published release, restarts into it, and keeps it once it stays up', async () => {
    const m = machine({ answers: true });
    const first = m.boot();
    expect(await m.serverRanFrom(1)).toBe(binOf(m.image));
    // CI publishes; no deploy command runs. The machine's release check
    // downloads it and exits, and so does the machine.
    publish(scratch, store, keys, 2);
    expect(await first.exited).toBe(1);
    expect(existsSync(join(m.releases, 'incoming', 'channel.json'))).toBe(true);

    // The restart boots the release, and three answers in a row make it current.
    const second = m.boot();
    expect(await m.serverRanFrom(2)).toBe(binOf(join(m.releases, commitFor(2))));
    await waitFor(() => readState(m.releases).current?.commit === commitFor(2), {
      timeout: 20_000,
      describe: 'the release to be promoted',
    });
    second.kill();

    // The release check ran as its own user, holding no secret.
    const envs = readdirSync(m.log)
      .filter((n) => n.startsWith('.release-env.'))
      .map((n) => readFileSync(join(m.log, n), 'utf8'));
    expect(envs.length).toBeGreaterThan(0);
    for (const text of envs) {
      expect(text).toContain('uid=cwrelease');
      for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    }
  }, 60_000);

  it('rolls back to the release before when the new one fails to boot', async () => {
    const m = machine({ answers: false, failRelease: true });
    publish(scratch, store, keys, 3);
    const first = m.boot();
    expect(await m.serverRanFrom(1)).toBe(binOf(m.image));
    expect(await first.exited).toBe(1);

    // The new release's server exits at once, and so does the machine.
    const second = m.boot();
    expect(await m.serverRanFrom(2)).toBe(binOf(join(m.releases, commitFor(3))));
    expect(await second.exited).toBe(1);

    // The next boot rolls back, and the failed release is not downloaded again.
    const third = m.boot();
    expect(await m.serverRanFrom(3)).toBe(binOf(m.image));
    const s = readState(m.releases);
    expect(s.trial).toBeNull();
    expect(s.failed.map((f) => f.commit)).toEqual([commitFor(3)]);
    third.kill();
  }, 60_000);
});
