/**
 * The steps of moving a board onto a project machine, written once.
 *
 * The scripts build their commands from this file, and the keeper reads the
 * same list to decide what a move grant covers (`keeper-grants.ts`) and to
 * show it on the approval page (`keeper-page.ts`). So the page cannot name a
 * step the grant does not cover, and a script cannot drift from the grant:
 * a changed command is held for a tap.
 *
 * `fly ssh console --command` is a root shell whose output goes back to the
 * requester, so a grant never covers it as a command. It covers only the
 * exact strings below, each with one board id or one base64 word filled in.
 * Neither can carry a shell metacharacter.
 *
 * Those strings run the probes in the machine's image, so they are only as
 * fixed as the image. That is why `fly deploy` is not a step: a requester
 * that could deploy without a tap could replace a probe, and a listed
 * command would then be a root shell that answers to it. For the same reason
 * secrets are covered only with `--stage`, which changes nothing on the
 * machine until a deploy, and that deploy is a tap.
 *
 * This file imports nothing: it runs in the keeper, on the Mac and on the
 * machine.
 */

export const BOARD_ID = /^w-[A-Za-z0-9_-]{6,64}$/;
const BASE64_WORD = /^[A-Za-z0-9+/]+={0,2}$/;
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** `projectConfig` allows no bigger volume. */
const MAX_VOLUME_GB = 50;

const BOARD_PROBE = 'bun /app/infra/project-machine/board-probe.ts';
export const WALL_PROBE = 'bun /app/infra/project-machine/wall-probe.ts';

/** The image's PATH, where `bun` and `setpriv` live (oven/bun's debian base). */
const MACHINE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const singleQuoted = (command: string): string => `'${command.replaceAll("'", `'\\''`)}'`;

/** The `--command` value `onMachine` sends for `command`. */
export const machineShell = (command: string): string => `sh -c ${singleQuoted(command)}`;

/**
 * `command`, for `onMachine`, run as `cw` with a clean environment. The
 * server's loopback uid door admits `cw` alone (security review M3), so a
 * machine tool that calls the server's REST cannot run as root, which keeps
 * only the power to switch users. `env -i` first: a `fly ssh console` shell
 * carries the machine's Fly secrets, and cw must never hold the tunnel token
 * or the bucket credential (run-as.sh, MACHINE_SECRETS). The whole command,
 * `;` and `&&` included, runs as cw. `path` is the machine's PATH; a test
 * passes its own.
 */
export function asCw(command: string, path = MACHINE_PATH): string {
  return [
    'env -i',
    `PATH=${path}`,
    'HOME=/home/cw USER=cw LOGNAME=cw',
    'CW_DATA_DIR=/data/cw BACKUP_TRANSCRIPTS_DIR=/data/claude-projects',
    'setpriv --reuid=cw --regid=cw --init-groups --',
    machineShell(command),
  ].join(' ');
}

/** What `machine:move-board` runs on the machine for one board. */
export function moveCommands(board: string) {
  const up = `/data/board-import-${board}`;
  return {
    upload: `${up}/bundle.tgz`,
    holds: `${BOARD_PROBE} holds ${board}`,
    prepare: `if [ -e ${up} ]; then rm -r ${up}; fi; mkdir -m 700 ${up}`,
    holdOff: 'touch /data/maintenance',
    importBundle: `mkdir ${up}/b && tar --no-same-owner --no-same-permissions -xzf ${up}/bundle.tgz -C ${up}/b && ${BOARD_PROBE} import ${up}/b ${board}`,
    release: `chown -R cw:cw /data/cw; rm -r ${up}; rm -f /data/maintenance`,
    serving:
      "curl -s -o /dev/null -w '%{http_code}' -H 'host: localhost:8787' http://127.0.0.1:8787/api/deploy || true",
    fingerprint: (limits: string) => asCw(`${BOARD_PROBE} fingerprint ${board} ${limits}`),
  };
}

/** A held fly call as the keeper classified it. */
export interface HeldFly {
  args?: readonly string[];
  setup?: boolean;
  /** The names its stdin sets, or null when a line of it is not `NAME=value`. */
  secrets?: readonly string[] | null;
}

/** The names a `fly secrets import` stdin sets, or null if any line hides what it sets. */
export function inputNames(input: string | undefined): string[] | null {
  const lines = (input ?? '').split('\n').filter((l) => l !== '');
  const names = lines.map((l) => (l.includes('=') ? (l.split('=', 1)[0] as string) : ''));
  return names.every((n) => SECRET_NAME.test(n)) ? names : null;
}

export interface MoveStep {
  /** What the step does, in words. */
  label: string;
  /** The command, as the approval page shows it. */
  shown: string;
  covers(call: HeldFly, app: string): boolean;
}

const starts = (args: readonly string[], ...words: string[]): boolean =>
  words.every((w, i) => args[i] === w);

/** The `--command` of a `fly ssh console` written as `onMachine` writes it, or null. */
function consoleCommand(args: readonly string[], app: string): string | null {
  const shape = args.length === 6 && starts(args, 'ssh', 'console', '--app', app, '--command');
  return shape ? (args[5] as string) : null;
}

const exactly = (label: string, command: string): MoveStep => ({
  label,
  shown: command,
  covers: (call, app) => consoleCommand(call.args ?? [], app) === machineShell(command),
});

/** A command with one word of base64 in it, the only part a requester chooses. */
function withWord(label: string, word: string, build: (w: string) => string): MoveStep {
  const [before, after] = machineShell(build('\0')).split('\0') as [string, string];
  return {
    label,
    shown: build(`<${word}>`),
    covers: (call, app) => {
      const c = consoleCommand(call.args ?? [], app);
      if (c === null || !c.startsWith(before) || !c.endsWith(after)) return false;
      if (c.length <= before.length + after.length) return false;
      return BASE64_WORD.test(c.slice(before.length, c.length - after.length));
    },
  };
}

/**
 * Every step a move grant for `board` covers. Anything else stays held.
 * `secrets` are the names the owner saw: an import of any other is held.
 */
export function moveSteps(board: string, secrets: readonly string[] = []): MoveStep[] {
  const c = moveCommands(board);
  const importStep: MoveStep = {
    label: 'Stage these secrets, which take effect at the next deploy',
    shown: `fly secrets import --stage: ${secrets.join(', ')}`,
    covers: (call) => {
      const a = call.args ?? [];
      const names = call.secrets;
      return (
        call.setup === true &&
        starts(a, 'secrets', 'import') &&
        a.includes('--stage') &&
        Array.isArray(names) &&
        names.length > 0 &&
        names.every((n) => secrets.includes(n))
      );
    },
  };
  return [
    {
      label: 'Create the project volume',
      shown: `fly volume create <name> --region <region> --size <1-${MAX_VOLUME_GB}> --yes`,
      covers: (call) => {
        const a = call.args ?? [];
        const at = a.indexOf('--size');
        const gb = at === -1 ? Number.NaN : Number(a[at + 1]);
        const sized = Number.isInteger(gb) && gb >= 1 && gb <= MAX_VOLUME_GB;
        return call.setup === true && (a[0] ?? '').startsWith('volume') && sized;
      },
    },
    ...(secrets.length ? [importStep] : []),
    {
      label: 'Stage the removal of secrets',
      shown: 'fly secrets unset <names> --stage',
      covers: (call) => {
        const a = call.args ?? [];
        return starts(a, 'secrets', 'unset') && a.includes('--stage');
      },
    },
    exactly('Check the machine does not hold the board', c.holds),
    exactly('Make the root-only upload folder', c.prepare),
    {
      label: 'Copy the bundle up',
      shown: `fly ssh sftp put <bundle> ${c.upload}`,
      covers: (call, app) => {
        const a = call.args ?? [];
        return (
          a.length === 7 &&
          starts(a, 'ssh', 'sftp', 'put') &&
          a[4] === c.upload &&
          a[5] === '--app' &&
          a[6] === app
        );
      },
    },
    exactly('Hold services off', c.holdOff),
    exactly('Unpack and import the bundle', c.importBundle),
    exactly('Remove the upload and let services start', c.release),
    exactly('Ask whether the server answers', c.serving),
    withWord('Fingerprint the board', 'base64 line limits', c.fingerprint),
    exactly('Wall check: mint expired test values', `${WALL_PROBE} mint`),
    withWord(
      'Wall check: judge another machine’s values',
      'base64 batch',
      (w) => `${WALL_PROBE} verify ${w}`,
    ),
    exactly('Wall check: read this machine’s walls', `${WALL_PROBE} machine`),
  ];
}
