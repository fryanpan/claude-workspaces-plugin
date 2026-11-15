#!/usr/bin/env bun
/**
 * The boot half of a pushed board (`board-import-store.ts`), run by
 * `entrypoint.sh` as `cw` before the server starts:
 *
 *   bun board-import-cli.ts apply
 *
 * Reads CW_DATA_DIR, CW_BOARD_IMPORT_DIR and CW_BOARD_IMPORT_BOARDS from the
 * environment. Without an import dir it does nothing. It always exits 0: a
 * refused import is written to the board's status, and the server still
 * starts.
 */
import { applyStaged, parseImportBoards } from './board-import-store.ts';

const say = (line: string) => console.error(`[board-import] ${line}`);

if (import.meta.main) {
  const root = process.env.CW_BOARD_IMPORT_DIR?.trim();
  if (process.argv[2] !== 'apply') {
    say('usage: board-import-cli.ts apply');
  } else if (!root) {
    say('CW_BOARD_IMPORT_DIR is not set: nothing to import');
  } else {
    try {
      const lines = applyStaged({
        root,
        dataDir: process.env.CW_DATA_DIR ?? '/data/cw',
        boards: parseImportBoards(process.env.CW_BOARD_IMPORT_BOARDS),
      });
      for (const line of lines) say(line);
    } catch (e) {
      say(`could not apply staged imports: ${(e as Error).message}`);
    }
  }
}
