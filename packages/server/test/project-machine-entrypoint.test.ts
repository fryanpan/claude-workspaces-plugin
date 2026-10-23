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
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { waitFor } from './wait-for.ts';

const repoRoot = join(import.meta.dir, '..', '..', '..');
const entrypoint = join(repoRoot, 'infra', 'project-machine', 'entrypoint.sh');

/** Fixture secrets: obviously fake, and distinct, so a leak names itself. */
const SECRETS = {
  CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token-riverbend',
  BACKUP_S3_ACCESS_KEY_ID: 'access-key-harborlight',
  BACKUP_S3_SECRET_ACCESS_KEY: 'secret-key-saltmarsh',
};
const SERVER_OWN = { CW_ORG_ANTHROPIC_API_KEY: 'org-key-riverbend' };

/** A bash that has `wait -n` (4.3+): macOS's /bin/bash is 3.2. */
function modernBash(): string | null {
  const bash = Bun.which('bash');
  if (!bash) return null;
  const v = spawnSync(bash, ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], {
    encoding: 'utf8',
  }).stdout.trim();
  const [major = 0, minor = 0] = v.split('.').map(Number);
  return major > 4 || (major === 4 && minor >= 3) ? bash : null;
}
const BASH = modernBash();
if (BASH === null) console.warn('[project-machine-entrypoint] SKIPPED: no bash 4.3+ on PATH');

const scratch = mkdtempSync(join(tmpdir(), 'machine-entrypoint-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Rec {
  uid: string;
  argv: string;
  env: Map<string, string>;
}

function stubs(idOutput: string): { bin: string; log: string } {
  const root = mkdtempSync(join(scratch, 'run-'));
  const bin = join(root, 'bin');
  const log = join(root, 'log');
  mkdirSync(bin);
  mkdirSync(log);
  const write = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // Every program a child runs as records who it is, then a long-lived one
  // stays up so the supervisor does not see it exit.
  // Written aside and moved in, so a reader never sees half a record.
  const record = `f=$(/usr/bin/mktemp "${log}/.part.XXXXXX")
{ echo "uid=\${STUB_UID:-root}"; echo "argv=$(basename "$0") $*"; /usr/bin/env; } > "$f"
/bin/mv "$f" "${log}/rec.$$.$RANDOM"`;
  // Root until setpriv has run; after it, the user it was asked for.
  write('id', `if [ -n "$STUB_UID" ]; then echo 10001; else echo ${idOutput}; fi`);
  write(
    'setpriv',
    `f=$(/usr/bin/mktemp "${log}/setpriv.XXXXXX"); echo "argv=setpriv $*" > "$f"
while [ $# -gt 0 ]; do
  case $1 in --reuid=*) export STUB_UID=\${1#--reuid=};; --) shift; break;; esac
  shift
done
exec "$@"`,
  );
  write('bun', `${record}\ncase "$*" in *bin.ts*) exec /bin/sleep 1000;; esac\nexit 0`);
  write('cloudflared', `${record}\nexec /bin/sleep 1000`);
  // The first backup waits an hour; everything else that sleeps waits long.
  write('sleep', 'case $1 in 3600) exit 0;; *) exec /bin/sleep 1000;; esac');
  for (const name of ['mkdir', 'ln', 'chown', 'chmod']) write(name, 'exit 0');
  return { bin, log };
}

function readRecords(log: string): { recs: Rec[]; setprivArgv: string[] } {
  const recs: Rec[] = [];
  const setprivArgv: string[] = [];
  for (const name of readdirSync(log)) {
    if (name.startsWith('.')) continue;
    const text = readFileSync(join(log, name), 'utf8');
    if (name.startsWith('setpriv.')) {
      setprivArgv.push(text.trim());
      continue;
    }
    const [uidLine = '', argvLine = '', ...envLines] = text.split('\n');
    const env = new Map<string, string>();
    for (const line of envLines) {
      const i = line.indexOf('=');
      if (i > 0) env.set(line.slice(0, i), line.slice(i + 1));
    }
    recs.push({ uid: uidLine.replace(/^uid=/, ''), argv: argvLine.replace(/^argv=/, ''), env });
  }
  return { recs, setprivArgv };
}

function machineEnv(bin: string): Record<string, string> {
  return {
    PATH: `${bin}:${dirname(BASH ?? '/bin/bash')}:/usr/bin:/bin`,
    ...SECRETS,
    ...SERVER_OWN,
    BACKUP_RECIPIENT: 'age1harborlight',
    BACKUP_S3_BUCKET: 'harborlight-backups',
    BACKUP_S3_ENDPOINT: 'https://storage.riverbend.test',
  };
}

describe.skipIf(BASH === null)('the project machine process tree', () => {
  it('runs the server as cw without the tunnel token or the bucket credential', async () => {
    const { bin, log } = stubs('0');
    // Its own process group, so the test can stop everything it started.
    const child = spawn(BASH as string, [entrypoint], {
      env: machineEnv(bin),
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

  it('refuses to start as any user but root', () => {
    const { bin, log } = stubs('10001');
    const r = spawnSync(BASH as string, [entrypoint], { env: machineEnv(bin), encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(readRecords(log).recs).toEqual([]);
  });
});
