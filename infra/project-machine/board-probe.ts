#!/usr/bin/env bun
/**
 * Runs ON the machine, as root over `fly ssh console`, for `machine:move-board`.
 *
 *   bun board-probe.ts holds <board>                  {"holds": true|false}
 *   bun board-probe.ts import <bundle dir>            the bundle into the data dir;
 *                                                     only while /data/maintenance holds the server off
 *   bun board-probe.ts fingerprint <board> [<limits>] the board's fingerprint (board-print.ts)
 *
 * `<limits>` is the base64 JSON of the source's log line counts, so the logs
 * are compared on what the export held. Talks to the server on loopback only.
 */
import { existsSync } from 'node:fs';
import { BOARD_ID, holdsBoard, importBoard } from './board-bundle.ts';
import { type BoardLimits, boardPrint, loopbackGet } from './board-print.ts';

const DATA = process.env.CW_DATA_DIR ?? '/data/cw';
const BASE = 'http://127.0.0.1:8787';

function board(arg: string | undefined): string {
  if (!arg || !BOARD_ID.test(arg)) throw new Error(`not a board id: ${arg}`);
  return arg;
}

async function run(cmd: string | undefined, a: string | undefined, b: string | undefined) {
  if (cmd === 'holds') return { holds: holdsBoard(DATA, board(a)) };
  if (cmd === 'import') {
    if (!existsSync('/data/maintenance')) {
      throw new Error(
        'refusing to import while the server runs: touch /data/maintenance and restart',
      );
    }
    if (!a) throw new Error('import <bundle dir>');
    const m = importBoard(a, DATA);
    return { imported: m.boardId, files: m.files.length };
  }
  if (cmd === 'fingerprint') {
    const limits = b ? (JSON.parse(Buffer.from(b, 'base64').toString('utf8')) as BoardLimits) : {};
    return boardPrint(loopbackGet(BASE), DATA, board(a), limits);
  }
  throw new Error('holds, import or fingerprint');
}

run(process.argv[2], process.argv[3], process.argv[4]).then(
  (out) => console.log(JSON.stringify(out)),
  (err: unknown) => {
    console.error(`[board-probe] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
