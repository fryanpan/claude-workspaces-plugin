/**
 * Stand-ins for running the project machine's shell scripts with no
 * container, shared by `project-machine-entrypoint.test.ts` and
 * `project-machine-lead.test.ts`.
 *
 * `id`, `setpriv`, `bun`, `cloudflared`, `claude`, `tmux`, `git` and the
 * file-ownership commands are stubs on PATH. The `setpriv` stub records the
 * user it was asked for, and every program it starts records that user, its
 * arguments and its whole environment.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const repoRoot = join(import.meta.dir, '..', '..', '..');
export const machineDir = join(repoRoot, 'infra', 'project-machine');

/** Fixture secrets: obviously fake, and distinct, so a leak names itself. */
export const SECRETS = {
  CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token-riverbend',
  BACKUP_S3_ACCESS_KEY_ID: 'access-key-harborlight',
  BACKUP_S3_SECRET_ACCESS_KEY: 'secret-key-saltmarsh',
};
export const SERVER_OWN = { CW_ORG_ANTHROPIC_API_KEY: 'org-key-riverbend' };

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
export const BASH: string | null = modernBash();

export interface Rec {
  uid: string;
  argv: string;
  env: Map<string, string>;
}

export interface Stubs {
  root: string;
  bin: string;
  log: string;
  volume: string;
}

/**
 * Stubs under a fresh folder in `scratch`. `real` names stubs to leave out,
 * so the real program on PATH runs; `bodies` replaces a stub's body.
 */
export function stubs(
  scratch: string,
  idOutput: string,
  real: string[] = [],
  bodies: Record<string, string> = {},
): Stubs {
  const root = mkdtempSync(join(scratch, 'run-'));
  // The volume's root: the test user's, 0700, so only its owner writes it.
  const volume = join(root, 'data');
  mkdirSync(volume, { mode: 0o700 });
  const bin = join(root, 'bin');
  const log = join(root, 'log');
  mkdirSync(bin);
  mkdirSync(log);
  const write = (name: string, body: string) => {
    if (real.includes(name)) return;
    writeFileSync(join(bin, name), `#!/bin/bash\n${bodies[name] ?? body}\n`);
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
  // Claude Code: records itself and its pid, then stays up, or exits at once
  // while the file .claude-exits exists.
  write(
    'claude',
    `${record}\necho $$ >> "${log}/.claude-pids"\n[ -e "${log}/.claude-exits" ] && exit 1\nexec /bin/sleep 1000`,
  );
  // tmux, as far as lead.sh uses it: a session is its one command, and it
  // exists while that command runs. As in tmux, a command given as one word
  // runs through the user's shell ($SHELL, else the login shell, which for
  // the machine's users is nologin), and one given as several words runs
  // directly.
  write(
    'tmux',
    `state="${log}/.tmux"; /bin/mkdir -p "$state"
cmd=$1; shift
case $cmd in
  new-session)
    name=""
    while [ $# -gt 0 ]; do case $1 in -d) shift;; -s) name=$2; shift 2;; -x|-y|-c) shift 2;; *) break;; esac; done
    if [ $# -eq 1 ]; then
      # Bash fills in SHELL when the environment has none; tmux would not.
      sh=$(/usr/bin/printenv SHELL || echo /usr/sbin/nologin)
      ( exec "$sh" -c "$1" ) </dev/null >/dev/null 2>&1 &
    else
      ( exec "$@" ) </dev/null >/dev/null 2>&1 &
    fi
    echo $! > "$state/$name.pid" ;;
  has-session)
    p=$(cat "$state/$2.pid" 2>/dev/null) && kill -0 "$p" 2>/dev/null ;;
  kill-server)
    for f in "$state"/*.pid; do kill "$(cat "$f")" 2>/dev/null; done; exit 0 ;;
esac`,
  );
  // The first backup waits an hour, and root's wait before it starts the
  // lead's supervisor again is 10s: both pass at once. Everything else that
  // sleeps waits long.
  write(
    'sleep',
    'case $1 in 3600) exit 0;; 10) exec /bin/sleep 0.2;; *) exec /bin/sleep 1000;; esac',
  );
  // git, as far as lead.sh uses it: its arguments, one line per call.
  write('git', `echo "\${STUB_UID:-root} $*" >> "${log}/.git"`);
  for (const name of ['mkdir', 'ln']) write(name, 'exit 0');
  // Each line is the user it ran as and its arguments; a symlink among them
  // adds a line of its own.
  write(
    'chown',
    `for a in "$@"; do if [ -L "$a" ]; then echo "link $a" >> "${log}/.chown"; fi; done
echo "\${STUB_UID:-root} $*" >> "${log}/.chown"`,
  );
  // Recorded, for the mode the snapshot is handed to the uploader with.
  write('chmod', `echo "\${STUB_UID:-root} $*" >> "${log}/.chmod"`);
  // A body for a program with no stub above is a stub of its own.
  for (const [name, body] of Object.entries(bodies)) write(name, body);
  return { root, bin, log, volume };
}

export function readRecords(log: string): { recs: Rec[]; setprivArgv: string[] } {
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

export function lines(log: string, name: string): string[] {
  try {
    return readFileSync(join(log, name), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function machineEnv(bin: string, volume: string): Record<string, string> {
  return {
    PATH: `${bin}:${dirname(BASH ?? '/bin/bash')}:/usr/bin:/bin`,
    CW_MACHINE_DATA_ROOT: volume,
    ...SECRETS,
    ...SERVER_OWN,
    BACKUP_RECIPIENT: 'age1harborlight',
    BACKUP_S3_BUCKET: 'harborlight-backups',
    BACKUP_S3_ENDPOINT: 'https://storage.riverbend.test',
  };
}
