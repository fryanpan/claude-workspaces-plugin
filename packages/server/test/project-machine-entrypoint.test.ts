/**
 * Which user each of the project machine's processes runs as, and which
 * secrets it holds (security review, 22 October 2026, finding 1).
 *
 * Processes of one user can read each other's environment, so the board
 * server must run under a uid that no process holding the tunnel token or the
 * bucket credential shares. This runs the real `entrypoint.sh` and
 * `backup-once.sh` with no container: `id`, `setpriv`, `bun`, `cloudflared`
 * and the file-ownership commands are stubs on PATH. The `setpriv` stub
 * records the user it was asked for, and every program it starts records
 * that user, its arguments and its whole environment. The uploader's record
 * holding the bucket credential is the positive control: the recorder sees a
 * secret when one is there.
 *
 * The root steps (security review, 23 October 2026, S1): root must never
 * change the owner or mode of a path `cw` could have swapped for a symlink.
 * The volume's root is a scratch directory here (`CW_MACHINE_DATA_ROOT`).
 * A test cannot run as root, so `chown` is a stub that records its
 * arguments and whether each one was a symlink when it ran; `mkdir` and
 * `chmod` are real where a test says so, so a followed link shows up as a
 * changed mode on the link's target. What this does not prove: that Linux's
 * `chown -h` and `[ -O ]` behave as the stubs and macOS's do, and that cw
 * cannot write the volume's root on a real machine. That is the image's.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
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
  stubs as stubsIn,
} from './project-machine-harness.ts';
import { waitFor } from './wait-for.ts';

const entrypoint = join(machineDir, 'entrypoint.sh');
const backupOnce = join(machineDir, 'backup-once.sh');

if (BASH === null) console.warn('[project-machine-entrypoint] SKIPPED: no bash 4.3+ on PATH');

const scratch = mkdtempSync(join(tmpdir(), 'machine-entrypoint-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const stubs = (idOutput: string, real: string[] = [], bodies: Record<string, string> = {}) =>
  stubsIn(scratch, idOutput, real, bodies);

describe.skipIf(BASH === null)('the project machine process tree', () => {
  it('runs the server as cw without the tunnel token or the bucket credential', async () => {
    const { bin, log, volume } = stubs('0');
    // Its own process group, so the test can stop everything it started.
    const child = spawn(BASH as string, [entrypoint], {
      env: machineEnv(bin, volume),
      detached: true,
      stdio: 'ignore',
    });
    try {
      const find = (recs: Rec[], needle: string) => recs.find((r) => r.argv.includes(needle));
      const started = (needles: string[], what: string) =>
        waitFor(() => needles.every((n) => find(readRecords(log).recs, n)), {
          timeout: 20_000,
          describe: what,
        });
      // The server and the tunnel start at once; the backup after its first
      // wait, which the sleep stub skips.
      await started(['bin.ts', 'cloudflared'], 'the server and cloudflared to start');
      const early = readRecords(log).recs;
      expect(find(early, 'bin.ts')?.uid).toBe('cw');
      expect(find(early, 'cloudflared')?.uid).toBe('cwtunnel');
      await started(['--out', '--upload'], 'both halves of the first backup to run');
      const { recs, setprivArgv } = readRecords(log);
      const server = find(recs, 'bin.ts');
      const tunnel = find(recs, 'cloudflared');
      const snapshot = find(recs, '--out');
      const uploader = find(recs, '--upload');

      expect(snapshot?.uid).toBe('cw');
      expect(uploader?.uid).toBe('cwbackup');
      // The snapshot is made 0600; the uploader reads it through its group.
      // cw opens it, not root: the name is in a directory cw writes.
      const snap = `${volume}/backup-outbox/snapshot.cwsnap`;
      expect(lines(log, '.chmod').filter((l) => l.endsWith(snap))).toEqual([`cw 0640 ${snap}`]);
      // Root takes the volume's root back, and gives cw only what is inside.
      const chowns = lines(log, '.chown');
      expect(chowns).toContain(`root root:root ${volume}`);
      expect(lines(log, '.chmod')).toContain(`root 0755 ${volume}`);
      expect(chowns.filter((l) => l.includes('cw:') && l.split(' ').includes(volume))).toEqual([]);
      expect(chowns.filter((l) => l.startsWith('link '))).toEqual([]);

      const values = Object.values(SECRETS);
      // Nothing the server's user runs holds a secret, under any name.
      for (const rec of recs.filter((r) => r.uid === 'cw')) {
        const held = [...rec.env.values()].filter((v) => values.some((s) => v.includes(s)));
        expect(held).toEqual([]);
      }
      // ...while the server still gets its own key, and a home of its own.
      expect(server?.env.get('CW_ORG_ANTHROPIC_API_KEY')).toBe(SERVER_OWN.CW_ORG_ANTHROPIC_API_KEY);
      expect(server?.env.get('HOME')).toBe('/home/cw');

      // POSITIVE CONTROL: each other user holds its own secret and only that.
      expect(tunnel?.env.get('TUNNEL_TOKEN')).toBe(SECRETS.CLOUDFLARE_TUNNEL_TOKEN);
      // PWD, SHLVL and _ are the stub shells' own.
      const bashOwn = new Set(['PWD', 'SHLVL', '_', 'OLDPWD']);
      expect([...(tunnel?.env.keys() ?? [])].filter((k) => !bashOwn.has(k)).sort()).toEqual(
        ['HOME', 'LOGNAME', 'PATH', 'STUB_UID', 'TUNNEL_TOKEN', 'USER'].sort(),
      );
      expect(uploader?.env.get('BACKUP_S3_SECRET_ACCESS_KEY')).toBe(
        SECRETS.BACKUP_S3_SECRET_ACCESS_KEY,
      );
      expect(uploader?.env.has('CLOUDFLARE_TUNNEL_TOKEN')).toBe(false);
      expect(uploader?.env.has('CW_ORG_ANTHROPIC_API_KEY')).toBe(false);

      // Nothing ran as root but the supervisor, and no secret was ever an
      // argument, which any user can read.
      expect(recs.filter((r) => r.uid === 'root').map((r) => r.argv)).toEqual([]);
      const argvs = [...recs.map((r) => r.argv), ...setprivArgv];
      expect(argvs.filter((a) => values.some((s) => a.includes(s)))).toEqual([]);
    } finally {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    }
  }, 30_000);

  it("runs the project's dev server as cwdev, in its own folder, with PATH and the proxy's address and nothing else", async () => {
    const devRecord = `d=$(dirname "$0")/../log; f=$(/usr/bin/mktemp "$d/.part.XXXXXX")
{ echo "uid=\${STUB_UID:-root}"; echo "argv=devserve $*"; /usr/bin/env; } > "$f"
/bin/mv "$f" "$d/rec.dev.$$"
exec /bin/sleep 1000`;
    const { bin, log, volume } = stubs('0', [], { devserve: devRecord });
    // The mkdir stub makes nothing, so the folder cwdev would make is made here.
    mkdirSync(join(volume, 'dev', 'work'), { recursive: true });
    const env = {
      ...machineEnv(bin, volume),
      CW_DEV_SERVER_CMD: 'devserve --host 127.0.0.1 --port 5173',
    };
    const child = spawn(BASH as string, [entrypoint], { env, detached: true, stdio: 'ignore' });
    try {
      const dev = () => readRecords(log).recs.find((r) => r.argv.startsWith('devserve'));
      const server = () => readRecords(log).recs.find((r) => r.argv.includes('bin.ts'));
      await waitFor(() => dev() !== undefined && server() !== undefined, {
        timeout: 20_000,
        describe: 'the dev server and the board server',
      });
      const rec = dev();
      expect(rec?.uid).toBe('cwdev');
      expect(rec?.argv).toBe('devserve --host 127.0.0.1 --port 5173');
      expect(rec?.env.get('PWD')).toBe(realpathSync(join(volume, 'dev', 'work')));
      expect(rec?.env.get('HOME')).toBe('/home/cwdev');
      const bashOwn = new Set(['PWD', 'SHLVL', '_', 'OLDPWD']);
      expect([...(rec?.env.keys() ?? [])].filter((k) => !bashOwn.has(k)).sort()).toEqual(
        [
          'HOME',
          'LOGNAME',
          'PATH',
          'STUB_UID',
          'USER',
          // The network wall's proxy (lead-proxy.ts), its one way out.
          'HTTPS_PROXY',
          'HTTP_PROXY',
          'NO_PROXY',
          'http_proxy',
          'https_proxy',
          'no_proxy',
        ].sort(),
      );
      // Its folder is its own and the lead's group's, setgid, and nobody else's.
      expect(lines(log, '.chown')).toContain(`root -h cwdev:cwdevsrc ${volume}/dev`);
      expect(lines(log, '.chmod')).toContain(`root 2770 ${volume}/dev`);
      // CONTROL: the server, beside it, still runs as cw with its own key.
      expect(server()?.uid).toBe('cw');
      expect(server()?.env.get('CW_ORG_ANTHROPIC_API_KEY')).toBe(
        SERVER_OWN.CW_ORG_ANTHROPIC_API_KEY,
      );
    } finally {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    }
  }, 30_000);

  it('runs no dev server when none is configured', async () => {
    const { bin, log, volume } = stubs('0');
    const child = spawn(BASH as string, [entrypoint], {
      env: machineEnv(bin, volume),
      detached: true,
      stdio: 'ignore',
    });
    try {
      await waitFor(() => readRecords(log).recs.some((r) => r.argv.includes('bin.ts')), {
        timeout: 20_000,
        describe: 'the server',
      });
      expect(readRecords(log).recs.filter((r) => r.uid === 'cwdev')).toEqual([]);
    } finally {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    }
  }, 30_000);

  it('refuses to start as any user but root', () => {
    const { bin, log, volume } = stubs('10001');
    const r = spawnSync(BASH as string, [entrypoint], {
      env: machineEnv(bin, volume),
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(readRecords(log).recs).toEqual([]);
  }, 30_000);
});

describe.skipIf(BASH === null)('root on the volume', () => {
  /** A directory a symlink can point at, with a mode a followed chmod changes. */
  function victim(): string {
    const dir = mkdtempSync(join(scratch, 'victim-'));
    chmodSync(dir, 0o700);
    return dir;
  }
  const modeOf = (p: string) => statSync(p).mode & 0o7777;

  it('refuses to back up when the outbox is a symlink, and changes nothing it points at', () => {
    const { bin, log, volume } = stubs('0', ['mkdir', 'chmod']);
    const target = victim();
    symlinkSync(target, join(volume, 'backup-outbox'));
    const r = spawnSync(BASH as string, [backupOnce], {
      env: machineEnv(bin, volume),
      encoding: 'utf8',
    });
    // A real chmod 2750 through the link would have changed this.
    expect(modeOf(target)).toBe(0o700);
    expect(lines(log, '.chown')).toEqual([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('is a symlink');
    expect(readRecords(log).recs).toEqual([]);
  });

  it('refuses to back up when anyone but its owner can write the volume root', () => {
    const { bin, log, volume } = stubs('0', ['mkdir', 'chmod']);
    chmodSync(volume, 0o775);
    const r = spawnSync(BASH as string, [backupOnce], {
      env: machineEnv(bin, volume),
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('only root can write');
    expect(lines(log, '.chown')).toEqual([]);
    expect(readRecords(log).recs).toEqual([]);
  });

  it('refuses to boot when the data dir is a symlink, and never chowns through it', async () => {
    const { bin, log, volume } = stubs('0');
    symlinkSync(victim(), join(volume, 'cw'));
    // Detached, so a boot that does not refuse is stopped rather than left
    // running its children.
    const child = spawn(BASH as string, [entrypoint], {
      env: machineEnv(bin, volume),
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    let status: number | null = null;
    child.on('close', (code) => {
      status = code;
    });
    try {
      await waitFor(() => status !== null, { timeout: 10_000, describe: 'the entrypoint to exit' });
    } finally {
      if (status === null && child.pid) process.kill(-child.pid, 'SIGKILL');
    }
    expect(status as number | null).toBe(2);
    expect(stderr).toContain(`${volume}/cw is a symlink`);
    expect(lines(log, '.chown').filter((l) => l.startsWith('link '))).toEqual([]);
    expect(lines(log, '.chown').filter((l) => l.includes('cw:'))).toEqual([]);
    expect(readRecords(log).recs).toEqual([]);
  }, 30_000);
});
