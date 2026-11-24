/**
 * The steps of moving a board onto a project machine, written once: the
 * exact commands `machine:move-board` and the wall check run on a machine
 * (`infra/project-machine/move-board.ts`, `mac-ops.ts`, `wall-drift.ts`).
 *
 * Each is a fixed string with one board id or one base64 word filled in, and
 * neither can carry a shell metacharacter. They run the probes in the
 * machine's image as root, so they are only as fixed as the image.
 *
 * This file imports nothing: it runs on the Mac and on the machine.
 */

export const BOARD_ID = /^w-[A-Za-z0-9_-]{6,64}$/;

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
