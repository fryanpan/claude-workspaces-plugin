/**
 * The transcript store's midnight inventory: every file this host would
 * upload and how many bytes of whole lines it held at 00:00 UTC, written as
 * `<host>/inventory/<YYYY-MM-DD>.json.zst.cw` for the day just begun.
 *
 * It is a step separate from the uploader on purpose: the sizes come from the
 * files, not from what the uploader believes it sent, so the check
 * (`store-check.ts`) can find bytes the uploader never sent. Only where each
 * file's chunks live (its folder and rewrite generation) is read from the
 * uploader's state, so the two name the same objects.
 *
 * Bookkeeping, sealed to the owner's key and the review key.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import {
  type ObjectStore,
  type StoreKeys,
  UNSORTED,
  type UploadSource,
  loadState,
  seal,
  utcDay,
  validBoard,
} from './store-upload.ts';

export interface InventoryFile {
  kind: 'transcripts' | 'events';
  folder: string;
  name: string;
  gen: number;
  /** Bytes up to and including the last line break. */
  size: number;
}

export interface Inventory {
  version: 1;
  host: string;
  /** The UTC day that began when the sizes were read. */
  day: string;
  files: InventoryFile[];
}

export const inventoryKey = (host: string, day: string): string =>
  `${host}/inventory/${day}.json.zst.cw`;

/** `size` cut back to just past its last line break; a half-written line is not counted. */
function wholeLines(path: string, size: number): number {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - buf.length);
      const n = readSync(fd, buf, 0, end - start, start);
      const at = buf.subarray(0, n).lastIndexOf(0x0a);
      if (at >= 0) return start + at + 1;
      end = start;
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

export function takeInventory(opts: {
  sources: readonly UploadSource[];
  statePath: string;
  host: string;
  now: Date;
}): Inventory {
  const state = loadState(opts.statePath);
  const files: InventoryFile[] = [];
  for (const src of opts.sources) {
    let size: number;
    try {
      size = statSync(src.path).size;
    } catch {
      continue;
    }
    const rec = state.files[src.path];
    const folder =
      rec?.folder ?? (src.board !== null && validBoard(src.board) ? src.board : UNSORTED);
    files.push({
      kind: src.kind === 'transcript' ? 'transcripts' : 'events',
      folder,
      name: src.name,
      gen: rec?.gen ?? 0,
      size: wholeLines(src.path, size),
    });
  }
  return { version: 1, host: opts.host, day: utcDay(opts.now), files };
}

export async function writeInventory(
  inv: Inventory,
  store: ObjectStore,
  keys: Pick<StoreKeys, 'owner' | 'review'>,
): Promise<string> {
  const key = inventoryKey(inv.host, inv.day);
  await store.put(key, seal(Buffer.from(JSON.stringify(inv)), [keys.owner, keys.review]));
  return key;
}
